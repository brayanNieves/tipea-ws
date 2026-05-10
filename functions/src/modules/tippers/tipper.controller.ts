import { onCall, HttpsError } from "firebase-functions/v2/https";
import { admin, db } from "../../config/firebase";
import { buildStripeClient, stripeSecretKey } from "../../config/stripe";
import { tipperRepo } from "./tipper.repository";
import { recordEmailVerification, resolveCanonUid } from "./email-link";
import { checkOtp, isValidEmail, normalizeEmail, requestOtp } from "../auth/otp.service";
import { planCommissionFraction, pricingService } from "../pricing/pricing.service";

const MIN_WALLET_TOPUP_DOP = 200;

// Helper: any wallet operation that requires email verification routes here.
// Returns the canonical uid that owns the wallet for `email`, or throws an
// HttpsError with a friendly message.
async function requireVerifiedEmail(currentUid: string, rawEmail: string): Promise<string> {
  if (!isValidEmail(rawEmail)) {
    throw new HttpsError("invalid-argument", "Email inválido.");
  }
  try {
    return await resolveCanonUid(currentUid, rawEmail);
  } catch (err) {
    const code = err instanceof Error ? err.message : "";
    if (code === "EMAIL_NOT_VERIFIED") {
      throw new HttpsError("failed-precondition", "Verifica tu correo antes de usar el wallet.");
    }
    if (code === "EMAIL_MISMATCH") {
      throw new HttpsError(
        "permission-denied",
        "Este dispositivo verificó otro correo. Vuelve a verificar para cambiar."
      );
    }
    throw new HttpsError("unknown", "No se pudo validar el correo.");
  }
}

// ─────────────────────────────────────────────────────────────
// getTipper
// Returns the tipper snapshot. If `email` is provided AND verified by the
// current uid, returns the canonical wallet (cross-device persistent).
// Otherwise returns the per-device snapshot used for the onboarding trigger.
// ─────────────────────────────────────────────────────────────
export const getTipper = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const { email } = (request.data ?? {}) as { email?: string };

  let targetUid = request.auth.uid;
  if (email) {
    targetUid = await requireVerifiedEmail(request.auth.uid, email);
  }
  const snap = await tipperRepo.get(targetUid);
  return snap;
});

// ─────────────────────────────────────────────────────────────
// markOnboardingSeen
// Sets hasSeenWalletOnboarding = true on the per-device tipper. Idempotent.
// (Always operates on request.auth.uid — the onboarding trigger is per-device.)
// ─────────────────────────────────────────────────────────────
export const markOnboardingSeen = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  await tipperRepo.markOnboardingSeen(request.auth.uid);
  await tipperRepo.logEvent({ uid: request.auth.uid, type: "onboarding_dismissed" }).catch(() => {});
  return { ok: true };
});

// ─────────────────────────────────────────────────────────────
// sendWalletOtp
// Emails a 6-digit code to verify the customer's email before any wallet
// operation. Reuses the shared OTP infra (10-min expiry, rate-limited).
//
// Request:  { email }
// Response: { ok: true }
// ─────────────────────────────────────────────────────────────
export const sendWalletOtp = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const { email } = (request.data ?? {}) as { email?: string };
  if (!email || !isValidEmail(email)) {
    throw new HttpsError("invalid-argument", "Email inválido.");
  }
  const result = await requestOtp(email);
  if (!result.ok) {
    if (result.status === 429) throw new HttpsError("resource-exhausted", result.message);
    throw new HttpsError("internal", result.message);
  }
  return { ok: true };
});

// ─────────────────────────────────────────────────────────────
// verifyWalletOtp
// Validates the code and locks the wallet to either the current uid (first
// verifier of this email) or to the email's existing canonical uid (so the
// balance survives device changes). Returns the resolved canonUid so the
// frontend can persist the email for subsequent calls.
//
// Request:  { email, code }
// Response: { ok: true, canonUid }
// ─────────────────────────────────────────────────────────────
export const verifyWalletOtp = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const { email, code } = (request.data ?? {}) as { email?: string; code?: string };
  if (!email || !code) {
    throw new HttpsError("invalid-argument", "email y code son requeridos.");
  }
  const check = await checkOtp(email, code);
  if (!check.ok) {
    if (check.status === 410) throw new HttpsError("deadline-exceeded", check.message);
    if (check.status === 429) throw new HttpsError("resource-exhausted", check.message);
    if (check.status === 404) throw new HttpsError("not-found", check.message);
    throw new HttpsError("invalid-argument", check.message);
  }

  const { canonUid } = await recordEmailVerification(request.auth.uid, email);
  console.log(
    `✅ [verifyWalletOtp] uid=${request.auth.uid} → email=${normalizeEmail(email)} | canonUid=${canonUid}`
  );
  return { ok: true, canonUid };
});

// ─────────────────────────────────────────────────────────────
// createWalletTopupIntent
// Creates a Stripe PaymentIntent for a wallet top-up. Customer pays exactly
// `amount` (no fee uplift); TipApp absorbs the Stripe processing fee.
//
// Requires the email to be verified by the current device first.
//
// Request:  { amount, email }
// Response: { clientSecret, paymentIntentId, amount }
// ─────────────────────────────────────────────────────────────
export const createWalletTopupIntent = onCall(
  { secrets: [stripeSecretKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in first.");
    }
    const { amount, email } = (request.data ?? {}) as { amount?: number; email?: string };
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      throw new HttpsError("invalid-argument", "amount must be a number.");
    }
    if (amount < MIN_WALLET_TOPUP_DOP) {
      throw new HttpsError(
        "invalid-argument",
        `Minimum top-up is RD$ ${MIN_WALLET_TOPUP_DOP}.`
      );
    }
    if (!email) {
      throw new HttpsError("invalid-argument", "email is required.");
    }
    const canonUid = await requireVerifiedEmail(request.auth.uid, email);

    let stripe;
    try {
      stripe = buildStripeClient();
    } catch {
      throw new HttpsError("failed-precondition", "Payments not configured.");
    }

    const amountInCentavos = Math.round(amount * 100);

    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCentavos,
        currency: "dop",
        automatic_payment_methods: { enabled: true },
        metadata: {
          purpose: "wallet-topup",
          uid: request.auth.uid,
          canonUid,
          email: normalizeEmail(email),
          amountPesos: amount.toString(),
        },
      });

      tipperRepo
        .logEvent({
          uid: canonUid,
          type: "topup_intent_created",
          amount,
          paymentIntentId: paymentIntent.id,
        })
        .catch(() => {});

      console.log(
        `✅ [createWalletTopupIntent] id=${paymentIntent.id} | uid=${request.auth.uid} | canonUid=${canonUid} | RD$${amount}`
      );

      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount,
      };
    } catch (error) {
      console.error("❌ [createWalletTopupIntent]", error);
      const message = error instanceof Error ? error.message : "Top-up failed.";
      throw new HttpsError("unknown", message);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// confirmWalletTopup
// Verifies the PaymentIntent succeeded, then atomically credits the
// canonical wallet (`/tippers/{canonUid}.walletBalance`) and creates a
// /topups ledger entry. Idempotent on paymentIntentId.
//
// Request:  { amount, paymentIntentId, email }
// Response: { balance, alreadyApplied }
// ─────────────────────────────────────────────────────────────
export const confirmWalletTopup = onCall(
  { secrets: [stripeSecretKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in first.");
    }
    const { amount, paymentIntentId, email } = (request.data ?? {}) as {
      amount?: number;
      paymentIntentId?: string;
      email?: string;
    };
    if (typeof amount !== "number" || !paymentIntentId || !email) {
      throw new HttpsError("invalid-argument", "amount, paymentIntentId, email son requeridos.");
    }
    const canonUid = await requireVerifiedEmail(request.auth.uid, email);

    let stripe;
    try {
      stripe = buildStripeClient();
    } catch {
      throw new HttpsError("failed-precondition", "Payments not configured.");
    }

    let intent;
    try {
      intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (error) {
      console.error("❌ [confirmWalletTopup] retrieve failed", error);
      throw new HttpsError("not-found", "PaymentIntent not found.");
    }

    if (intent.status !== "succeeded") {
      throw new HttpsError("failed-precondition", `PaymentIntent status=${intent.status}.`);
    }
    if (intent.metadata?.purpose !== "wallet-topup") {
      throw new HttpsError("failed-precondition", "PaymentIntent is not a wallet top-up.");
    }
    if (intent.metadata?.canonUid !== canonUid) {
      throw new HttpsError("permission-denied", "PaymentIntent belongs to another wallet.");
    }
    const expectedCents = Math.round(amount * 100);
    if (intent.amount !== expectedCents) {
      throw new HttpsError("failed-precondition", "PaymentIntent amount mismatch.");
    }

    // Compute the loss-leader ledger: visible == credit, so TipApp eats
    // Stripe's processing + conversion fees on every top-up. Stored on
    // /topups so analytics can surface the burn rate without joining
    // against Stripe.
    const topupBreakdown = await pricingService.breakdownFor(
      amount,
      "card",
      intent.currency === "dop" ? "dop" : "usd"
    );

    const result = await tipperRepo.credit({
      uid: canonUid,
      amount,
      paymentIntentId,
      ledger: {
        stripeProcessingFee: topupBreakdown.stripeProcessingFee,
        stripeConversionFee: topupBreakdown.stripeConversionFee,
        tipappCost: topupBreakdown.totalProcessingCost,
        exchangeRate: topupBreakdown.exchangeRate,
      },
    });

    if (!result.alreadyApplied) {
      tipperRepo
        .logEvent({ uid: canonUid, type: "topup_success", amount, paymentIntentId })
        .catch(() => {});
    }

    console.log(
      `✅ [confirmWalletTopup] canonUid=${canonUid} | RD$${amount} | new=${result.balance} | dup=${result.alreadyApplied}`
    );

    return { balance: result.balance, alreadyApplied: result.alreadyApplied };
  }
);

// ─────────────────────────────────────────────────────────────
// tipFromWallet
// Atomically deducts the tip amount from the canonical wallet's balance
// and creates a /tips doc with paidFromWallet: true. The onTipCreated
// trigger then computes plan-based commission against `amount` (unchanged).
//
// Request:  { staffId, amount, email, songRequest?, rating?, comment? }
// Response: { tipId, remainingBalance }
// ─────────────────────────────────────────────────────────────
export const tipFromWallet = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const { staffId, amount, email, songRequest, rating, comment } = (request.data ?? {}) as {
    staffId?: string;
    amount?: number;
    email?: string;
    songRequest?: unknown;
    rating?: number | null;
    comment?: string | null;
  };
  if (!staffId) throw new HttpsError("invalid-argument", "staffId is required.");
  if (typeof amount !== "number" || amount <= 0) {
    throw new HttpsError("invalid-argument", "amount must be greater than zero.");
  }
  if (!email) throw new HttpsError("invalid-argument", "email is required.");

  const canonUid = await requireVerifiedEmail(request.auth.uid, email);

  // Verify staff exists before debiting to avoid wasted writes. Resolve
  // their plan rate so the pricing engine applies the same commission
  // tier (Starter 7% / Pro 4% / Business 2%) the trigger would have.
  const staffSnap = await db.doc(`users/${staffId}`).get();
  if (!staffSnap.exists) {
    throw new HttpsError("not-found", `Staff ${staffId} not found.`);
  }
  const staffData = staffSnap.data() ?? {};
  const staffPlanId = (staffData as { planId?: string }).planId;
  let staffPlanCommissionPct: number | null = null;
  if (staffPlanId) {
    const planSnap = await db.doc(`plans/${staffPlanId}`).get();
    const planData = planSnap.data() as { commissionPct?: number } | undefined;
    if (typeof planData?.commissionPct === "number") {
      staffPlanCommissionPct = planData.commissionPct;
    }
  }

  // Compute the wallet pricing breakdown (no Stripe fees on this row;
  // the top-up already absorbed them).
  const walletPricing = await pricingService.breakdownFor(
    amount,
    "wallet",
    "dop",
    planCommissionFraction(staffPlanCommissionPct)
  );

  try {
    const result = await tipperRepo.debitAndCreateTip({
      uid: canonUid,
      amount,
      tipWriter: (tx, tipRef) => {
        tx.set(tipRef, {
          userId: staffId,
          // senderUid is the CURRENT device uid so the onTipCreated trigger
          // bumps the per-device count for *this* device's onboarding metric.
          // The wallet itself debits canonUid.
          senderUid: request.auth?.uid ?? null,
          amount,
          paidFromWallet: true,
          source: "qr",
          status: "paid",
          payoutId: null,
          stripePaymentIntentId: null,
          paymentMethod: "wallet",
          pricing: walletPricing,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          songRequest: songRequest ?? null,
          rating: rating ?? null,
          comment: comment && typeof comment === "string" ? comment.trim() || null : null,
          ratedAt:
            typeof rating === "number" ? admin.firestore.FieldValue.serverTimestamp() : null,
        });
      },
    });

    tipperRepo
      .logEvent({ uid: canonUid, type: "wallet_tip", amount, staffId })
      .catch(() => {});

    console.log(
      `✅ [tipFromWallet] canonUid=${canonUid} | staffId=${staffId} | RD$${amount} | remaining=${result.remainingBalance}`
    );
    return result;
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "WALLET_NOT_FOUND" || code === "INSUFFICIENT_WALLET") {
      tipperRepo
        .logEvent({ uid: canonUid, type: "wallet_insufficient", amount, staffId })
        .catch(() => {});
      throw new HttpsError("failed-precondition", "Insufficient wallet balance.");
    }
    console.error("❌ [tipFromWallet]", error);
    throw new HttpsError("unknown", "Could not process tip.");
  }
});

// ─────────────────────────────────────────────────────────────
// logWalletEvent
// Lightweight client-side event recorder. Used for "onboarding_shown"
// (frontend is the only source of truth for this event).
// ─────────────────────────────────────────────────────────────
export const logWalletEvent = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const { type, amount, staffId } = (request.data ?? {}) as {
    type?: string;
    amount?: number;
    staffId?: string;
  };
  const allowed = new Set([
    "onboarding_shown",
    "onboarding_dismissed",
    "wallet_tip",
    "wallet_insufficient",
    "email_verify_started",
    "email_verify_success",
    "email_verify_failed",
  ]);
  if (!type || !allowed.has(type)) {
    throw new HttpsError("invalid-argument", "Invalid event type.");
  }
  await tipperRepo.logEvent({
    uid: request.auth.uid,
    type: type as
      | "onboarding_shown"
      | "onboarding_dismissed"
      | "wallet_tip"
      | "wallet_insufficient"
      | "email_verify_started"
      | "email_verify_success"
      | "email_verify_failed",
    amount,
    staffId,
  });
  return { ok: true };
});
