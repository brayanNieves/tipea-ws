import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { admin, db } from "../../config/firebase";
import { mailer } from "../../mailer_service";
import { getToday } from "../../shared/utils/date";
import { calculateCommission } from "./tip.service";
import { evaluateTip } from "./suspicion.service";
import { tipperRepo } from "../tippers/tipper.repository";
import { planCommissionFraction, pricingService } from "../pricing/pricing.service";
import type {
  TipPricingLedger,
  TipPricingPaymentMethod,
} from "../../types";

/**
 * Resolve the commission/net values + the pricing ledger for a tip.
 *
 * Three cases:
 *   1. Tip already has a `pricing` block (wallet path, or direct path when
 *      the FE attached the engine output from `createPaymentIntent`) →
 *      use it as-is. Its `platformFee` already reflects the staff's plan
 *      tier because the upstream callable resolved it.
 *   2. Tip lacks `pricing` but is recent → compute one using the staff's
 *      `plan.commissionPct` and write it back so /tips is uniform.
 *   3. Pricing engine itself errors → fall back to the legacy
 *      `calculateCommission(amount, plan.commissionPct)` path so the tip
 *      still settles with the right rate. Should never trigger in practice.
 */
async function resolvePricing(tip: FirebaseFirestore.DocumentData, planCommissionPct: number) {
  const existing = tip.pricing as TipPricingLedger | undefined;
  if (existing && typeof existing.platformFee === "number" && typeof existing.staffNet === "number") {
    const commissionPct = existing.visibleAmount > 0
      ? Math.round((existing.platformFee / existing.visibleAmount) * 1000) / 10
      : planCommissionPct;
    return {
      commissionPct,
      commissionAmt: existing.platformFee,
      netAmount: existing.staffNet,
      pricing: existing,
      computed: false,
    };
  }

  // No ledger yet — derive payment method from tip flags.
  const paymentMethod: TipPricingPaymentMethod = tip.paidFromWallet
    ? "wallet"
    : tip.paymentMethod === "apple_pay" || tip.paymentMethod === "google_pay"
      ? tip.paymentMethod
      : "card";
  const chargedCurrency = tip.paidFromWallet ? "dop" : "usd";

  try {
    const pricing = await pricingService.breakdownFor(
      tip.amount,
      paymentMethod,
      chargedCurrency,
      planCommissionFraction(planCommissionPct)
    );
    return {
      commissionPct: planCommissionPct,
      commissionAmt: pricing.platformFee,
      netAmount: pricing.staffNet,
      pricing,
      computed: true,
    };
  } catch (err) {
    // True last-resort: fall back to plan-based math so the tip still
    // settles. Surfaces a log line so we know to investigate.
    console.warn(
      `[onTipCreated] pricing engine failed; falling back to plan.commissionPct=${planCommissionPct}`,
      err
    );
    const legacy = calculateCommission(tip.amount, planCommissionPct ?? 0);
    return { ...legacy, pricing: undefined as TipPricingLedger | undefined, computed: false };
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

    // ── 4. Resolve commission via the pricing engine ─────────
    // Prefers the tip's pre-attached `pricing` block; falls back to
    // computing one (and ultimately to plan.commissionPct if the engine
    // itself can't run).
    const { commissionPct, commissionAmt, netAmount, pricing, computed } = await resolvePricing(
      tip,
      plan.commissionPct ?? 0
    );

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

    const tipUpdate: Record<string, unknown> = {
      commissionPct,
      commissionAmt,
      netAmount,
      status: "pending",
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
      grossAmount: tip.amount,
      commissionPct,
      commissionAmt,
      netAmount,
      status: "pending",
      settledAt: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const notifRef = db.collection("notifications").doc();
    batch.set(notifRef, {
      type: "new_tip",
      message: `${user.name} (${user.role}) received $${tip.amount} tip — your cut: $${commissionAmt}`,
      userId: tip.userId,
      role: user.role,
      tipId,
      amount: tip.amount,
      commissionAmt,
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
        if (!summarySnap.exists) {
          tx.set(summaryRef, {
            date: today,
            totalGross: tip.amount,
            totalCommissions: commissionAmt,
            totalPaidOut: 0,
            totalPending: netAmount,
            tipCount: 1,
            activeUsers: 1,
            closed: false,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(summaryRef, {
            totalGross: admin.firestore.FieldValue.increment(tip.amount),
            totalCommissions: admin.firestore.FieldValue.increment(commissionAmt),
            totalPending: admin.firestore.FieldValue.increment(netAmount),
            tipCount: admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }),

      db.runTransaction(async (tx) => {
        const statsSnap = await tx.get(statsRef);
        if (!statsSnap.exists) {
          tx.set(statsRef, {
            userId: tip.userId,
            userName: user.name,
            role: user.role,
            date: today,
            totalGross: tip.amount,
            commissionAmt,
            netEarned: netAmount,
            tipCount: 1,
            pending: netAmount,
            paidOut: 0,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(statsRef, {
            totalGross: admin.firestore.FieldValue.increment(tip.amount),
            commissionAmt: admin.firestore.FieldValue.increment(commissionAmt),
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
        amount: tip.amount,
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
        `gross=$${tip.amount} | commission=$${commissionAmt} | net=$${netAmount} | ` +
        `pricingSrc=${pricing ? (computed ? "computed" : "attached") : "legacy-plan"} | ` +
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
