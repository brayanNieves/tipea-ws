import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { admin, db } from "../../config/firebase";
import { mailer } from "../../mailer_service";
import { getToday } from "../../shared/utils/date";

// ─────────────────────────────────────────────────────────────
// onPayoutCreated
// Fires every time a bank transfer to a user is recorded.
//
// What it does:
//   1. Marks all included tips as "paid"
//   2. Creates a settled commission record
//   3. Updates user_daily_stats (moves pending → paidOut)
//   4. Updates daily_summaries
//   5. Creates a notification
//   6. Sends the staff member a payout email
// ─────────────────────────────────────────────────────────────
export const onPayoutCreated = onDocumentCreated(
  { document: "payouts/{payoutId}" },
  async (event) => {
    const snap = event.data;
    if (!snap) return null;

    const payout = snap.data();
    const payoutId = event.params.payoutId;
    const today = getToday();

    try {
      if (!payout.userId || !payout.netToUser || !payout.tipsIncluded?.length) {
        throw new Error(
          `Invalid payout data: userId=${payout.userId}, netToUser=${payout.netToUser}, tipsIncluded=${payout.tipsIncluded}`
        );
      }

      const userSnap = await db.doc(`users/${payout.userId}`).get();
      const user = userSnap.data();
      if (!user) throw new Error(`User not found: ${payout.userId}`);

      const batch = db.batch();
      for (const tipId of payout.tipsIncluded) {
        const tipRef = db.doc(`tips/${tipId}`);
        batch.update(tipRef, { status: "paid", payoutId });
      }

      const commissionRef = db.collection("commissions").doc();
      batch.set(commissionRef, {
        userId: payout.userId,
        sourceId: payoutId,
        sourceType: "payout",
        grossAmount: payout.grossAmount,
        commissionPct: 0,
        commissionAmt: payout.commissionAmt,
        status: "settled",
        settledAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const notifRef = db.collection("notifications").doc();
      batch.set(notifRef, {
        type: "payout_completed",
        message: `Transfer of $${payout.netToUser} completed for user ${payout.userId}`,
        userId: payout.userId,
        payoutId,
        amount: payout.netToUser,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await batch.commit();

      const statsRef = db.doc(`user_daily_stats/${payout.userId}_${today}`);
      const summaryRef = db.doc(`daily_summaries/${today}`);

      await Promise.all([
        statsRef.update({
          pending: admin.firestore.FieldValue.increment(-payout.netToUser),
          paidOut: admin.firestore.FieldValue.increment(payout.netToUser),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }),

        summaryRef.update({
          totalPaidOut: admin.firestore.FieldValue.increment(payout.netToUser),
          totalPending: admin.firestore.FieldValue.increment(-payout.netToUser),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
      ]);

      if (user.emailVerified === true && user.email) {
        await mailer.sendPayoutEmail({
          payoutId,
          grossAmount: payout.grossAmount,
          commissionAmt: payout.commissionAmt,
          netToUser: payout.netToUser,
          method: payout.method,
          bankName: payout.bankName,
          accountType: payout.accountType,
          accountLast4: payout.accountLast4,
          holderName: payout.holderName,
          referenceNumber: payout.referenceNumber ?? null,
          transferDate:
            payout.transferDate?.toDate?.()?.toISOString() ?? new Date().toISOString(),
          tipCount: payout.tipsIncluded.length,
          notes: payout.notes ?? null,
          staffName: user.name,
          staffEmail: user.email,
          staffRole: user.role,
        });
      } else {
        console.log(
          `⚠️ [onPayoutCreated] Skipping payout email — emailVerified=${user.emailVerified}, email=${user.email ?? "none"}`
        );
      }

      console.log(
        `✅ [onPayoutCreated] payoutId=${payoutId} | userId=${payout.userId} | amount=$${payout.netToUser}`
      );

      return null;
    } catch (error) {
      console.error(`❌ [onPayoutCreated] payoutId=${payoutId}`, error);

      await snap.ref
        .update({
          status: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          errorAt: admin.firestore.FieldValue.serverTimestamp(),
        })
        .catch(() => {
          /* noop */
        });

      await mailer.sendErrorMail(`onPayoutCreated — payoutId: ${payoutId}`, error);

      return null;
    }
  }
);
