import { onCall, HttpsError } from "firebase-functions/v2/https";
import { admin, db } from "../../config/firebase";
import { buildStripeClient, stripeSecretKey } from "../../config/stripe";
import { customerIdFromPhone, isValidDoPhone, normalizePhone } from "../../shared/utils/customer-id";
import { balanceRepo } from "./balance.repository";
import { customerFeeRepo } from "../payments/customer-fee.repository";
import { calculateCustomerFee } from "../payments/service-fee";

const MIN_TOPUP_DOP = 200;

// ─────────────────────────────────────────────────────────────
// lookupBalance
// Resolve a phone to a customerId + current balance. Returns exists=false
// when the customer hasn't topped up yet.
// ─────────────────────────────────────────────────────────────
export const lookupBalance = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const { phone } = (request.data ?? {}) as { phone?: string };
  if (!phone || typeof phone !== "string") {
    throw new HttpsError("invalid-argument", "phone es requerido.");
  }
  const normalized = normalizePhone(phone);
  if (!isValidDoPhone(normalized)) {
    throw new HttpsError("invalid-argument", "Número de teléfono inválido (debe ser un número dominicano de 10 dígitos).");
  }
  const customerId = customerIdFromPhone(normalized);
  const snap = await balanceRepo.get(customerId);
  return {
    customerId,
    phone: normalized,
    balance: snap.balance,
    exists: snap.exists,
  };
});

// ─────────────────────────────────────────────────────────────
// createTopupIntent
// Creates a Stripe PaymentIntent for a top-up. NO fee uplift — customer pays
// exactly `amount`. TipApp absorbs the Stripe processing fee, so the customer
// balance ends up equal to the gross paid.
//
// Request:  { phone, amount, email? }
// Response: { clientSecret, paymentIntentId, customerId, amount }
// ─────────────────────────────────────────────────────────────
export const createTopupIntent = onCall(
  { secrets: [stripeSecretKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }
    const { phone, amount, email } = (request.data ?? {}) as {
      phone?: string;
      amount?: number;
      email?: string | null;
    };
    if (!phone || typeof phone !== "string") {
      throw new HttpsError("invalid-argument", "phone es requerido.");
    }
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      throw new HttpsError("invalid-argument", "amount debe ser un número.");
    }
    if (amount < MIN_TOPUP_DOP) {
      throw new HttpsError("invalid-argument", `El monto mínimo de recarga es RD$ ${MIN_TOPUP_DOP}.`);
    }
    const normalized = normalizePhone(phone);
    if (!isValidDoPhone(normalized)) {
      throw new HttpsError("invalid-argument", "Número de teléfono inválido.");
    }
    const customerId = customerIdFromPhone(normalized);

    let stripe;
    try {
      stripe = buildStripeClient();
    } catch {
      throw new HttpsError("failed-precondition", "Configuración de pagos no disponible.");
    }

    // Charge in DOP, no fee uplift.
    const amountInCentavos = Math.round(amount * 100);

    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCentavos,
        currency: "dop",
        automatic_payment_methods: { enabled: true },
        metadata: {
          purpose: "topup",
          customerId,
          phone: normalized,
          email: email ?? "",
          amountPesos: amount.toString(),
          senderUid: request.auth.uid,
        },
      });
      console.log(
        `✅ [createTopupIntent] id=${paymentIntent.id} | from=${request.auth.uid} | customerId=${customerId} | RD$${amount}`
      );
      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        customerId,
        amount,
      };
    } catch (error) {
      console.error("❌ [createTopupIntent]", error);
      const message = error instanceof Error ? error.message : "No se pudo crear el intento de recarga.";
      throw new HttpsError("unknown", message);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// confirmTopup
// Verifies the PaymentIntent succeeded with Stripe, then atomically credits
// the customer's balance and creates a /topups ledger entry. Idempotent on
// paymentIntentId — calling twice will not double-credit.
//
// Request:  { phone, amount, paymentIntentId, email? }
// Response: { balance, alreadyApplied }
// ─────────────────────────────────────────────────────────────
export const confirmTopup = onCall(
  { secrets: [stripeSecretKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }
    const { phone, amount, paymentIntentId, email } = (request.data ?? {}) as {
      phone?: string;
      amount?: number;
      paymentIntentId?: string;
      email?: string | null;
    };
    if (!phone || !paymentIntentId || typeof amount !== "number") {
      throw new HttpsError("invalid-argument", "phone, amount y paymentIntentId son requeridos.");
    }
    const normalized = normalizePhone(phone);
    if (!isValidDoPhone(normalized)) {
      throw new HttpsError("invalid-argument", "Número de teléfono inválido.");
    }
    const customerId = customerIdFromPhone(normalized);

    let stripe;
    try {
      stripe = buildStripeClient();
    } catch {
      throw new HttpsError("failed-precondition", "Configuración de pagos no disponible.");
    }

    let intent;
    try {
      intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (error) {
      console.error("❌ [confirmTopup] retrieve failed", error);
      throw new HttpsError("not-found", "PaymentIntent no encontrado.");
    }

    if (intent.status !== "succeeded") {
      throw new HttpsError("failed-precondition", `PaymentIntent estado=${intent.status}, no procesado.`);
    }
    if (intent.metadata?.purpose !== "topup") {
      throw new HttpsError("failed-precondition", "PaymentIntent no es una recarga.");
    }
    if (intent.metadata?.customerId !== customerId) {
      throw new HttpsError("permission-denied", "PaymentIntent pertenece a otro cliente.");
    }
    const expectedCents = Math.round(amount * 100);
    if (intent.amount !== expectedCents) {
      throw new HttpsError("failed-precondition", "El monto del PaymentIntent no coincide.");
    }

    const result = await balanceRepo.credit({
      customerId,
      phone: normalized,
      email: email ?? null,
      amount,
      paymentIntentId,
    });

    console.log(
      `✅ [confirmTopup] customerId=${customerId} | RD$${amount} | new=${result.balance} | dup=${result.alreadyApplied}`
    );

    return { balance: result.balance, alreadyApplied: result.alreadyApplied };
  }
);

// ─────────────────────────────────────────────────────────────
// tipFromBalance
// Atomically deducts the tip amount from the customer balance and creates a
// /tips doc. The existing onTipCreated trigger then computes plan-based
// commission against `amount` (unchanged behavior).
//
// Request:  { phone, staffId, amount, songRequest?, rating?, comment? }
// Response: { tipId, remainingBalance }
// ─────────────────────────────────────────────────────────────
export const tipFromBalance = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const { phone, staffId, amount, songRequest, rating, comment } = (request.data ?? {}) as {
    phone?: string;
    staffId?: string;
    amount?: number;
    songRequest?: unknown;
    rating?: number | null;
    comment?: string | null;
  };
  if (!phone || !staffId) {
    throw new HttpsError("invalid-argument", "phone y staffId son requeridos.");
  }
  if (typeof amount !== "number" || amount <= 0) {
    throw new HttpsError("invalid-argument", "amount debe ser mayor a cero.");
  }
  const normalized = normalizePhone(phone);
  if (!isValidDoPhone(normalized)) {
    throw new HttpsError("invalid-argument", "Número de teléfono inválido.");
  }
  const customerId = customerIdFromPhone(normalized);

  // Verify staff exists and is active before debiting.
  const staffSnap = await db.doc(`users/${staffId}`).get();
  if (!staffSnap.exists) {
    throw new HttpsError("not-found", `Empleado ${staffId} no encontrado.`);
  }

  // The fee is charged to the CUSTOMER: tip + fee are debited from the
  // balance and staff receive the full tip.
  const feeConfig = await customerFeeRepo.read();
  const fee = calculateCustomerFee(amount, feeConfig.percentageFee, feeConfig.fixedFee);

  try {
    const result = await balanceRepo.debitAndCreateTip({
      customerId,
      amount: fee.customerPays,
      tipWriter: (tx, tipRef) => {
        tx.set(tipRef, {
          userId: staffId,
          // `amount` = the tip: what staff receive, 100% of it.
          amount,
          tipAmount: amount,
          feeCharged: fee.totalFee,
          customerPaid: fee.customerPays,
          customerId,
          paidFromBalance: true,
          source: "qr",
          status: "paid",
          payoutId: null,
          stripePaymentIntentId: null,
          paymentMethod: "balance",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          songRequest: songRequest ?? null,
          rating: rating ?? null,
          comment: comment && typeof comment === "string" ? comment.trim() || null : null,
          ratedAt:
            typeof rating === "number" ? admin.firestore.FieldValue.serverTimestamp() : null,
        });
      },
    });

    console.log(
      `✅ [tipFromBalance] customerId=${customerId} | staffId=${staffId} | RD$${amount} | remaining=${result.remainingBalance}`
    );
    return result;
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "BALANCE_NOT_FOUND") {
      throw new HttpsError("failed-precondition", "No tienes balance disponible. Recarga primero.");
    }
    if (code === "INSUFFICIENT_BALANCE") {
      throw new HttpsError("failed-precondition", "Balance insuficiente. Recarga para continuar.");
    }
    console.error("❌ [tipFromBalance]", error);
    throw new HttpsError("unknown", "No se pudo procesar la propina.");
  }
});
