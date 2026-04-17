import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { admin, db } from "../../config/firebase";
import { mailer } from "../../mailer_service";
import { getToday } from "../../shared/utils/date";
import { calculateCommission } from "./tip.service";
import { evaluateTip } from "./suspicion.service";

// ─────────────────────────────────────────────────────────────
// onTipCreated
// Fires every time a new document is created in /tips
//
// What it does:
//   1. Fetches the user's active plan
//   2. Calculates commission and net amount
//   3. Detects suspicious activity
//   4. Updates the tip document with those values
//   5. Creates a record in /commissions (income log)
//   6. Updates /daily_summaries (platform-wide dashboard)
//   7. Updates /user_daily_stats (per-user leaderboard)
//   8. Creates admin notifications
//   9. Sends staff email if user.emailVerified
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

    // ── 3. Fetch user's active plan ──────────────────────────
    const planSnap = await db.doc(`plans/${user.planId}`).get();
    const plan = planSnap.data();
    if (!plan) throw new Error(`Plan not found: ${user.planId}`);

    // ── 4. Calculate commission and net amount ───────────────
    const { commissionPct, commissionAmt, netAmount } = calculateCommission(
      tip.amount,
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

    batch.update(snap.ref, {
      commissionPct,
      commissionAmt,
      netAmount,
      status: "pending",
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      suspicious: isSuspicious,
      suspicionReasons: isSuspicious ? suspicionReasons : [],
      suspicionReviewed: false,
    });

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
