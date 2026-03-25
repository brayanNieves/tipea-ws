import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

admin.initializeApp();
const db = getFirestore();

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function getToday(): string {
  // Returns "2025-03-22" in DR timezone
  return new Date()
    .toLocaleDateString("en-CA", { timeZone: "America/Santo_Domingo" });
}

function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Santo_Domingo" });
}

// ─────────────────────────────────────────────────────────────
// onTipCreated
// Fires every time a new document is created in /tips
//
// What it does:
//   1. Fetches the user's active plan
//   2. Calculates commission and net amount
//   3. Updates the tip document with those values
//   4. Creates a record in /commissions (your income log)
//   5. Updates /daily_summaries (platform-wide dashboard)
//   6. Updates /user_daily_stats (per-user leaderboard)
//   7. Creates a notification for you (admin)
// ─────────────────────────────────────────────────────────────
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";

export const onTipCreated = onDocumentCreated({
  document: "tips/{tipId}",
}, async (event) => {
  const snap = event.data;
  if (!snap) return;
  const tip = snap.data();
  const tipId = event.params.tipId;
  const today = getToday();

  // ── 1. Get user ──────────────────────────────────────────
  const userSnap = await db.doc(`users/${tip.userId}`).get();
  const user = userSnap.data();

  if (!user) {
    console.error(`[onTipCreated] User not found: ${tip.userId}`);
    return null;
  }

  // ── 2. Get plan ──────────────────────────────────────────
  const planSnap = await db.doc(`plans/${user.planId}`).get();
  const plan = planSnap.data();

  if (!plan) {
    console.error(`[onTipCreated] Plan not found: ${user.planId}`);
    return null;
  }

  // ── 3. Calculate amounts ─────────────────────────────────
  const commissionPct: number = plan.commissionPct;
  const commissionAmt: number = Math.round((tip.amount * commissionPct) / 100);
  const netAmount: number = tip.amount - commissionAmt;

  // ── 4. Update tip with calculated values ─────────────────
  await snap.ref.update({
    commissionPct,
    commissionAmt,
    netAmount,
    status: "pending",
  });

  // ── 5. Create commission record ──────────────────────────
  await db.collection("commissions").add({
    userId: tip.userId,
    userName: user.name,
    userRole: user.role,
    sourceId: tipId,
    sourceType: "tip",
    grossAmount: tip.amount,
    commissionPct,
    commissionAmt,
    status: "pending",
    settledAt: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ── 6. Update daily_summaries (platform-wide) ────────────
  const summaryRef = db.doc(`daily_summaries/${today}`);
  await db.runTransaction(async (tx: any) => {
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
  });

  // ── 7. Update user_daily_stats (per user per day) ────────
  const statsId = `${tip.userId}_${today}`;
  const statsRef = db.doc(`user_daily_stats/${statsId}`);
  await db.runTransaction(async (tx: any) => {
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
  });

  // ── 8. Create notification for admin ─────────────────────
  await db.collection("notifications").add({
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

  console.log(
    `[onTipCreated] Tip ${tipId} processed | ` +
    `Gross: ${tip.amount} | Commission: ${commissionAmt} | Net: ${netAmount}`
  );

  return null;
});

// ─────────────────────────────────────────────────────────────
// onPayoutCreated
// Fires every time you record a bank transfer to a user
//
// What it does:
//   1. Marks all included tips as "paid"
//   2. Creates a settled commission record
//   3. Updates user_daily_stats (moves pending → paidOut)
//   4. Updates daily_summaries
//   5. Creates a notification
// ─────────────────────────────────────────────────────────────
export const onPayoutCreated = onDocumentCreated({
  document: "payouts/{payoutId}",
}, async (event) => {
  const snap = event.data;
  if (!snap) return;
  const payout = snap.data();
  const payoutId = event.params.payoutId;
  const today = getToday();

  // ── 1. Mark all included tips as paid ────────────────────
  const batch = db.batch();
  for (const tipId of payout.tipsIncluded) {
    const tipRef = db.doc(`tips/${tipId}`);
    batch.update(tipRef, {
      status: "paid",
      payoutId,
    });
  }
  await batch.commit();

  // ── 2. Create commission record ──────────────────────────
  await db.collection("commissions").add({
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

  // ── 3. Update user_daily_stats ───────────────────────────
  const statsId = `${payout.userId}_${today}`;
  const statsRef = db.doc(`user_daily_stats/${statsId}`);
  await statsRef.update({
    pending: admin.firestore.FieldValue.increment(-payout.netToUser),
    paidOut: admin.firestore.FieldValue.increment(payout.netToUser),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ── 4. Update daily_summaries ────────────────────────────
  const summaryRef = db.doc(`daily_summaries/${today}`);
  await summaryRef.update({
    totalPaidOut: admin.firestore.FieldValue.increment(payout.netToUser),
    totalPending: admin.firestore.FieldValue.increment(-payout.netToUser),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ── 5. Create notification ───────────────────────────────
  await db.collection("notifications").add({
    type: "payout_completed",
    message: `Transfer of $${payout.netToUser} completed for user ${payout.userId}`,
    userId: payout.userId,
    payoutId,
    amount: payout.netToUser,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`[onPayoutCreated] Payout ${payoutId} processed successfully`);

  return null;
});

// ─────────────────────────────────────────────────────────────
// onUserCreated
// Fires when a new user registers via Firebase Auth
//
// What it does:
//   1. Creates their Firestore profile document
//   2. Assigns Starter plan by default
//   3. Creates their subscription record
//   4. Notifies you (admin) of the new signup
// ─────────────────────────────────────────────────────────────
export const onUserCreated = functions.auth
  .user()
  .onCreate(async (user) => {
    const renewalDate = new Date();
    renewalDate.setMonth(renewalDate.getMonth() + 1);

    // ── 1. Create Firestore user document ────────────────────
    await db.doc(`users/${user.uid}`).set({
      name: user.displayName ?? "",
      email: user.email ?? "",
      phone: user.phoneNumber ?? "",
      role: "waiter",           // default role — user updates in onboarding
      planId: "plan_starter",   // everyone starts on Starter
      pin: null,
      active: true,
      bankAccount: null,        // user adds bank account later
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ── 2. Create subscription record ────────────────────────
    await db.doc(`subscriptions/${user.uid}`).set({
      userId: user.uid,
      planId: "plan_starter",
      status: "active",
      startDate: admin.firestore.FieldValue.serverTimestamp(),
      renewalDate,
      canceledAt: null,
    });

    // ── 3. Notify admin of new signup ─────────────────────────
    await db.collection("notifications").add({
      type: "user_signup",
      message: `New user signed up: ${user.email ?? user.uid}`,
      userId: user.uid,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[onUserCreated] New user profile created: ${user.uid}`);

    return null;
  });

// ─────────────────────────────────────────────────────────────
// onDayRollover
// Cron job — runs every day at midnight DR time
// Closes the daily summary for reporting
// ─────────────────────────────────────────────────────────────
export const onDayRollover = functions.pubsub
  .schedule("0 0 * * *")
  .timeZone("America/Santo_Domingo")
  .onRun(async () => {
    const yesterday = getYesterday();
    const summaryRef = db.doc(`daily_summaries/${yesterday}`);

    const summarySnap = await summaryRef.get();

    if (!summarySnap.exists) {
      console.log(`[onDayRollover] No summary found for ${yesterday}, skipping`);
      return null;
    }

    await summaryRef.update({
      closed: true,
      closedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[onDayRollover] Day ${yesterday} closed successfully`);

    return null;
  });

// ─────────────────────────────────────────────────────────────
// createTip (HTTP Callable API para ejecutar desde Flutter)
// ─────────────────────────────────────────────────────────────
export const createTip = onCall(async (request) => {
  // 1. Verificamos que el usuario esté logueado
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión para dar una propina.");
  }

  const { amount, targetUserId } = request.data;

  if (!amount || !targetUserId) {
    throw new HttpsError("invalid-argument", "Falta el monto (amount) o el ID del mesero (targetUserId).");
  }

  // 2. Guardamos la propina en Firestore. 
  // ¡Esto lanza AUTOMÁTICAMENTE el Trigger 'onTipCreated' que subimos antes!
  const tipRef = await db.collection("tips").add({
    userId: targetUserId,          // El ID del mesero/negocio que recibe
    senderUid: request.auth.uid,   // El ID de quien envió la propina
    amount: amount,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { success: true, tipId: tipRef.id, message: "Propina registrada con éxito." };
});
