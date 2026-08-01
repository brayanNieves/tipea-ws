import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { admin, db } from "../../config/firebase";
import { mailer } from "../../mailer_service";
import { getToday } from "../../shared/utils/date";
import { evaluateTip } from "./suspicion.service";
import { tipperRepo } from "../tippers/tipper.repository";
import { pricingService } from "../pricing/pricing.service";
import { customerFeeRepo } from "../payments/customer-fee.repository";
import { calculateCustomerFee } from "../payments/service-fee";
import type {
  TipPricingLedger,
  TipPricingPaymentMethod,
} from "../../types";

/**
 * Resolve the staff payout + the customer fee + the pricing ledger.
 *
 * MODEL RULE: staff ALWAYS receive 100% of the tip.
 *   staff payout   = tipAmount
 *   commission     = 0
 *   TipApp revenue = feeCharged (paid by the customer, tracked separately)
 *
 * Three cases:
 *   1. The tip already carries a `pricing` block (wallet path, or direct path
 *      when the FE attached the engine output from createPaymentIntent) →
 *      use it as-is.
 *   2. No `pricing` → compute one by reading /config/customerFee and write it
 *      back so /tips stays uniform.
 *   3. The engine throws → fall back with no fee; staff still get 100%.
 */
async function resolvePricing(tip: FirebaseFirestore.DocumentData) {
  // The tip is what staff receive. `amount` stays the canonical field;
  // `tipAmount` is the explicit alias written by the new FE.
  const tipAmount: number = tip.tipAmount ?? tip.amount;

  const existing = tip.pricing as TipPricingLedger | undefined;
  if (existing && typeof existing.staffNet === "number") {
    return {
      commissionPct: 0,
      commissionAmt: 0,
      // Guard: if an old ledger carries a reduced staffNet, the tip wins.
      netAmount: tipAmount,
      feeCharged: existing.customerFee ?? tip.feeCharged ?? 0,
      customerPaid: existing.visibleAmount ?? tip.customerPaid ?? tipAmount,
      pricing: existing,
      computed: false,
    };
  }

  // No ledger yet — derive the payment method from the tip flags.
  const paymentMethod: TipPricingPaymentMethod = tip.paidFromWallet
    ? "wallet"
    : tip.paymentMethod === "apple_pay" || tip.paymentMethod === "google_pay"
      ? tip.paymentMethod
      : "card";
  const chargedCurrency = tip.paidFromWallet ? "dop" : "usd";

  try {
    // Honour the fee already on the doc; otherwise recompute it from the
    // current config.
    let feeCharged: number = tip.feeCharged;
    if (typeof feeCharged !== "number" || !Number.isFinite(feeCharged) || feeCharged < 0) {
      const cfg = await customerFeeRepo.read();
      feeCharged = calculateCustomerFee(tipAmount, cfg.percentageFee, cfg.fixedFee).totalFee;
    }

    const pricing = await pricingService.breakdownFor(
      tipAmount,
      paymentMethod,
      chargedCurrency,
      feeCharged
    );
    return {
      commissionPct: 0,
      commissionAmt: 0,
      netAmount: pricing.staffNet, // === tipAmount
      feeCharged: pricing.customerFee,
      customerPaid: pricing.visibleAmount,
      pricing,
      computed: true,
    };
  } catch (err) {
    // Last resort: the tip still settles and staff still get 100%.
    console.warn(`[onTipCreated] pricing engine failed; settling with no fee`, err);
    return {
      commissionPct: 0,
      commissionAmt: 0,
      netAmount: tipAmount,
      feeCharged: typeof tip.feeCharged === "number" ? tip.feeCharged : 0,
      customerPaid: typeof tip.customerPaid === "number" ? tip.customerPaid : tipAmount,
      pricing: undefined as TipPricingLedger | undefined,
      computed: false,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// onTipCreated
// Fires every time a new document is created in /tips.
//
// What it does:
//   1. Resolves the pricing ledger (existing or computed via engine)
//   2. Detects suspicious activity
//   3. Updates the tip with pricing + commission/net + status
//   4. Creates a /commissions record
//   5. Updates /daily_summaries + /user_daily_stats
//   6. Creates admin notifications
//   7. Sends staff email if user.emailVerified
//   8. Bumps /tippers counters via tipperRepo.recordTip
// ─────────────────────────────────────────────────────────────
export const onTipCreated = onDocumentCreated({ document: "tips/{tipId}" }, async (event) => {
  const snap = event.data;
  if (!snap) return null;

  const tip = snap.data();
  const tipId = event.params.tipId;
  const today = getToday();

  try {
    // ── 1. Validate required tip fields ──────────────────────
    if (!tip.userId || !tip.amount || tip.amount <= 0) {
      throw new Error(`Invalid tip data: userId=${tip.userId}, amount=${tip.amount}`);
    }

    // ── 2. Fetch user document ───────────────────────────────
    const userSnap = await db.doc(`users/${tip.userId}`).get();
    const user = userSnap.data();
    if (!user) throw new Error(`User not found: ${tip.userId}`);
    const emailVerified = user?.emailVerified ?? false;

    // ── 3. Fetch user's active plan (still needed for staff email) ──
    const planSnap = await db.doc(`plans/${user.planId}`).get();
    const plan = planSnap.data();
    if (!plan) throw new Error(`Plan not found: ${user.planId}`);

    // ── 4. Resolve the staff payout and the customer fee ─────
    // Staff get 100%: commissionAmt always 0, netAmount = the tip.
    const {
      commissionPct,
      commissionAmt,
      netAmount,
      feeCharged,
      customerPaid,
      pricing,
      computed,
    } = await resolvePricing(tip);
    const tipAmount: number = tip.tipAmount ?? tip.amount;

    // ── 4.5. Detect suspicious activity ──────────────────────
    const { isSuspicious, reasons: suspicionReasons } = await evaluateTip({
      userId: tip.userId,
      amount: tip.amount,
      source: tip.source,
    });

    // ── 5. Batch simple writes ───────────────────────────────
    const summaryRef = db.doc(`daily_summaries/${today}`);
    const statsRef = db.doc(`user_daily_stats/${tip.userId}_${today}`);
    const batch = db.batch();

    // Dev tips bypass real payment and need to land as `paid` so they show
    // up in reports without manual SQL massaging. Real tips still settle as
    // `pending` and only flip to `paid` after the payout cycle runs.
    const isDevTip = tip.paymentMethod === "dev";
    const resolvedStatus = isDevTip ? (tip.status ?? "paid") : "pending";

    const tipUpdate: Record<string, unknown> = {
      commissionPct, // 0 — nothing is deducted from staff
      commissionAmt, // 0
      netAmount, // === tipAmount, 100% of the tip
      // Customer fee breakdown (TipApp revenue).
      tipAmount,
      feeCharged,
      customerPaid,
      status: resolvedStatus,
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      suspicious: isSuspicious,
      suspicionReasons: isSuspicious ? suspicionReasons : [],
      suspicionReviewed: false,
    };
    // Persist the pricing block so /tips is uniform regardless of which
    // path created the doc.
    if (computed && pricing) tipUpdate.pricing = pricing;
    batch.update(snap.ref, tipUpdate);

    const commissionRef = db.collection("commissions").doc();
    batch.set(commissionRef, {
      userId: tip.userId,
      userName: user.name,
      userRole: user.role,
      sourceId: tipId,
      sourceType: "tip",
      grossAmount: tipAmount,
      commissionPct, // 0
      commissionAmt, // 0 — nothing is deducted from staff
      netAmount, // staff receive 100%
      // TipApp's actual revenue is the fee the customer paid.
      feeCharged,
      customerPaid,
      status: "pending",
      settledAt: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const notifRef = db.collection("notifications").doc();
    batch.set(notifRef, {
      type: "new_tip",
      message: `${user.name} (${user.role}) recibió una propina de RD$ ${tipAmount} — fee al cliente: RD$ ${feeCharged}`,
      userId: tip.userId,
      role: user.role,
      tipId,
      amount: tipAmount,
      commissionAmt, // 0
      feeCharged,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (isSuspicious) {
      const suspiciousNotifRef = db.collection("notifications").doc();
      batch.set(suspiciousNotifRef, {
        type: "suspicious_activity",
        message: `Suspicious tip from ${user.name}: RD$ ${tip.amount}`,
        userId: tip.userId,
        tipId,
        reasons: suspicionReasons,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();

    // ── 5b. Update /tippers counter (drives wallet onboarding trigger) ──
    if (tip.senderUid && typeof tip.senderUid === "string") {
      await tipperRepo.recordTip(tip.senderUid, tip.amount).catch((e) => {
        console.error("[onTipCreated] tipperRepo.recordTip failed (non-fatal)", e);
      });
    }

    // ── 6. Run counter transactions in parallel ──────────────
    await Promise.all([
      db.runTransaction(async (tx) => {
        const summarySnap = await tx.get(summaryRef);
        // `totalCommissions` is still the admin's revenue KPI, but it is now
        // fed by the customer fee (it used to be the staff commission).
        if (!summarySnap.exists) {
          tx.set(summaryRef, {
            date: today,
            totalGross: tipAmount,
            totalCommissions: feeCharged,
            totalCustomerFees: feeCharged,
            totalPaidOut: 0,
            totalPending: netAmount,
            tipCount: 1,
            activeUsers: 1,
            closed: false,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(summaryRef, {
            totalGross: admin.firestore.FieldValue.increment(tipAmount),
            totalCommissions: admin.firestore.FieldValue.increment(feeCharged),
            totalCustomerFees: admin.firestore.FieldValue.increment(feeCharged),
            totalPending: admin.firestore.FieldValue.increment(netAmount),
            tipCount: admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }),

      db.runTransaction(async (tx) => {
        const statsSnap = await tx.get(statsRef);
        // `commissionAmt` stays 0 (nothing deducted from staff);
        // `feeCollected` accumulates what customers paid for this user.
        if (!statsSnap.exists) {
          tx.set(statsRef, {
            userId: tip.userId,
            userName: user.name,
            role: user.role,
            date: today,
            totalGross: tipAmount,
            commissionAmt,
            feeCollected: feeCharged,
            netEarned: netAmount,
            tipCount: 1,
            pending: netAmount,
            paidOut: 0,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(statsRef, {
            totalGross: admin.firestore.FieldValue.increment(tipAmount),
            commissionAmt: admin.firestore.FieldValue.increment(commissionAmt),
            feeCollected: admin.firestore.FieldValue.increment(feeCharged),
            netEarned: admin.firestore.FieldValue.increment(netAmount),
            tipCount: admin.firestore.FieldValue.increment(1),
            pending: admin.firestore.FieldValue.increment(netAmount),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }),
    ]);

    // ── 7. Send tip notification email to staff ──────────────
    if (user.emailVerified && user.email) {
      await mailer.sendTipStaffEmail({
        tipId,
        amount: tipAmount,
        commissionPct,
        commissionAmt,
        netAmount,
        source: tip.source ?? "qr",
        createdAt: new Date().toISOString(),
        staffId: tip.userId,
        staffName: user.name,
        staffEmail: user.email,
        staffRole: user.role,
        planId: user.planId,
        planName: plan.name,
      });
    } else {
      console.log(
        `⚠️ [onTipCreated] Skipping staff email — emailVerified=${emailVerified}, email=${user.email ?? "none"}`
      );
    }

    console.log(
      `✅ [onTipCreated] tipId=${tipId} | user=${user.name} | ` +
        `tip=RD$${tipAmount} | staffNet=RD$${netAmount} (100%) | ` +
        `customerFee=RD$${feeCharged} | customerPaid=RD$${customerPaid} | ` +
        `pricingSrc=${pricing ? (computed ? "computed" : "attached") : "none"} | ` +
        `suspicious=${isSuspicious}`
    );

    return null;
  } catch (error) {
    console.error(`❌ [onTipCreated] tipId=${tipId}`, error);

    await snap.ref
      .update({
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        errorAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      .catch(() => {
        /* noop */
      });

    await mailer.sendErrorMail(`onTipCreated — tipId: ${tipId}`, error);

    return null;
  }
});
