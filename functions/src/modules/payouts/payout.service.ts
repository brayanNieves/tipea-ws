import { db } from "../../config/firebase";
import { mailer } from "../../mailer_service";
import { getToday } from "../../shared/utils/date";
import { FieldValue } from "firebase-admin/firestore";

// ─────────────────────────────────────────────────────────────
// processPayout
// Everything a recorded payout does, shared by onPayoutCreated and the
// admin's retryPayout:
//   1. Marks all included tips as "paid" (payoutId = this payout)
//   2. Creates a settled commission record
//   3. Updates user_daily_stats (moves pending → paidOut)
//   4. Updates daily_summaries
//   5. Creates a notification
//   6. Leaves the payout in status "paid", clearing any previous error
//   7. Sends the staff member a payout email — a failed email is saved as
//      emailError and does NOT fail the payout (the money already moved)
// Throws when steps 1–6 fail; the caller records the error.
// ─────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function processPayout(payoutId: string, payout: any): Promise<void> {
  const today = getToday();
  const payoutRef = db.doc(`payouts/${payoutId}`);

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
    settledAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  });

  const notifRef = db.collection("notifications").doc();
  batch.set(notifRef, {
    type: "payout_completed",
    message: `Transfer of $${payout.netToUser} completed for user ${payout.userId}`,
    userId: payout.userId,
    payoutId,
    amount: payout.netToUser,
    read: false,
    createdAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();

  const statsRef = db.doc(`user_daily_stats/${payout.userId}_${today}`);
  const summaryRef = db.doc(`daily_summaries/${today}`);

  // set+merge, not update: on a day with no tips yet these docs don't
  // exist, and update() would fail after the tips were already marked paid.
  await Promise.all([
    statsRef.set(
      {
        userId: payout.userId,
        userName: user.name ?? null,
        role: user.role ?? null,
        date: today,
        pending: FieldValue.increment(-payout.netToUser),
        paidOut: FieldValue.increment(payout.netToUser),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    ),

    summaryRef.set(
      {
        date: today,
        closed: false,
        totalPaidOut: FieldValue.increment(payout.netToUser),
        totalPending: FieldValue.increment(-payout.netToUser),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    ),
  ]);

  await payoutRef.set(
    {
      status: "paid",
      errorMessage: FieldValue.delete(),
      errorAt: FieldValue.delete(),
      processedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  try {
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
  } catch (err) {
    console.error(`⚠️ [processPayout] payout email failed — payoutId=${payoutId}`, err);
    await payoutRef
      .set({ emailError: err instanceof Error ? err.message : String(err) }, { merge: true })
      .catch(() => {
        /* noop */
      });
  }
}
