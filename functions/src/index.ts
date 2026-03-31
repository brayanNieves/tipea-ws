import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { mailer } from "./mailer_service";

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
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import * as corsLib from "cors";

const corsHandler = corsLib.default({ origin: true });

export const onTipCreated = onDocumentCreated({
  document: "tips/{tipId}",
}, async (event) => {
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

    // ── 3. Fetch user's active plan ──────────────────────────
    const planSnap = await db.doc(`plans/${user.planId}`).get();
    const plan = planSnap.data();
    if (!plan) throw new Error(`Plan not found: ${user.planId}`);

    // ── 4. Calculate commission and net amount ───────────────
    const commissionPct: number = plan.commissionPct ?? 0;
    const commissionAmt: number = Math.round((tip.amount * commissionPct) / 100);
    const netAmount: number = tip.amount - commissionAmt;

    // ── 4.5. Detect suspicious activity ─────────────────────
    const suspicionReasons: string[] = [];

    if (tip.amount > 5000) {
      suspicionReasons.push(`Unusually high tip amount: RD$ ${tip.amount}`);
    }

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const recentTipsSnap = await db.collection("tips")
      .where("userId", "==", tip.userId)
      .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(fiveMinutesAgo))
      .get();

    if (recentTipsSnap.size > 1) {
      suspicionReasons.push(`${recentTipsSnap.size} tips submitted within 5 minutes`);
    }

    if (tip.amount >= 1000 && tip.amount % 1000 === 0) {
      suspicionReasons.push(`Suspiciously round amount: RD$ ${tip.amount}`);
    }

    if (tip.source === "manual" && tip.amount > 2000) {
      suspicionReasons.push(`High manual tip (no QR): RD$ ${tip.amount}`);
    }

    const isSuspicious = suspicionReasons.length > 0;

    // ── 5. Batch simple writes ───────────────────────────────
    const summaryRef = db.doc(`daily_summaries/${today}`);
    const statsRef = db.doc(`user_daily_stats/${tip.userId}_${today}`);
    const batch = db.batch();

    // Update tip document with calculated values
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

    // Create commission income record
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

    // Create admin notification
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

    // Create suspicious activity notification if needed
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

      // Update platform-wide daily summary
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

      // Update per-user daily stats (leaderboard)
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

    console.log(
      `✅ [onTipCreated] tipId=${tipId} | user=${user.name} | ` +
      `gross=$${tip.amount} | commission=$${commissionAmt} | net=$${netAmount} | ` +
      `suspicious=${isSuspicious}`
    );

    return null;

  } catch (error) {
    console.error(`❌ [onTipCreated] tipId=${tipId}`, error);

    await snap.ref.update({
      status: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      errorAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => { });

    await mailer.sendErrorMail(`onTipCreated — tipId: ${tipId}`, error);

    return null;
  }
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
  if (!snap) return null;

  const payout = snap.data();
  const payoutId = event.params.payoutId;
  const today = getToday();

  try {
    // ── 1. Validate required payout fields ───────────────────
    if (!payout.userId || !payout.netToUser || !payout.tipsIncluded?.length) {
      throw new Error(
        `Invalid payout data: userId=${payout.userId}, netToUser=${payout.netToUser}, tipsIncluded=${payout.tipsIncluded}`
      );
    }

    // ── 2. Mark all included tips as paid ────────────────────
    const batch = db.batch();
    for (const tipId of payout.tipsIncluded) {
      const tipRef = db.doc(`tips/${tipId}`);
      batch.update(tipRef, { status: "paid", payoutId });
    }

    // ── 3. Create settled commission record ──────────────────
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

    // ── 4. Create payout notification ────────────────────────
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

    // ── 5. Update counters in parallel ───────────────────────
    const statsRef = db.doc(`user_daily_stats/${payout.userId}_${today}`);
    const summaryRef = db.doc(`daily_summaries/${today}`);

    await Promise.all([
      // Move pending → paidOut in user daily stats
      statsRef.update({
        pending: admin.firestore.FieldValue.increment(-payout.netToUser),
        paidOut: admin.firestore.FieldValue.increment(payout.netToUser),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }),

      // Update platform-wide daily summary
      summaryRef.update({
        totalPaidOut: admin.firestore.FieldValue.increment(payout.netToUser),
        totalPending: admin.firestore.FieldValue.increment(-payout.netToUser),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }),
    ]);

    console.log(`✅ [onPayoutCreated] payoutId=${payoutId} | userId=${payout.userId} | amount=$${payout.netToUser}`);

    return null;

  } catch (error) {
    console.error(`❌ [onPayoutCreated] payoutId=${payoutId}`, error);

    // Mark payout as failed so it doesn't get stuck without a status
    await snap.ref.update({
      status: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      errorAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => { }); // silently ignore if this update also fails

    // Send error details to admin via email
    await mailer.sendErrorMail(`onPayoutCreated — payoutId: ${payoutId}`, error);

    return null;
  }
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
    try {
      const renewalDate = new Date();
      renewalDate.setMonth(renewalDate.getMonth() + 1);

      // ── 1. Batch all writes together ─────────────────────────
      const batch = db.batch();

      // Create subscription record
      batch.set(db.doc(`subscriptions/${user.uid}`), {
        userId: user.uid,
        planId: "plan_starter",
        status: "active",
        startDate: admin.firestore.FieldValue.serverTimestamp(),
        renewalDate,
        canceledAt: null,
      });

      // Create admin notification
      const notifRef = db.collection("notifications").doc();
      batch.set(notifRef, {
        type: "user_signup",
        message: `New user signed up: ${user.email ?? user.uid}`,
        userId: user.uid,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await batch.commit();

      console.log(`✅ [onUserCreated] New user profile created: ${user.uid}`);

      return null;

    } catch (error) {
      console.error(`❌ [onUserCreated] uid=${user.uid}`, error);

      // Send error details to admin via email
      await mailer.sendErrorMail(`onUserCreated — uid: ${user.uid}`, error);

      return null;
    }
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

    try {
      const summaryRef = db.doc(`daily_summaries/${yesterday}`);
      const summarySnap = await summaryRef.get();

      // No summary for yesterday — nothing to close, skip silently
      if (!summarySnap.exists) {
        console.log(`⚠️ [onDayRollover] No summary found for ${yesterday}, skipping`);
        return null;
      }

      // Mark the day as closed
      await summaryRef.update({
        closed: true,
        closedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`✅ [onDayRollover] Day ${yesterday} closed successfully`);

      return null;

    } catch (error) {
      console.error(`❌ [onDayRollover] Failed to close day ${yesterday}`, error);

      // Send error details to admin via email
      await mailer.sendErrorMail(`onDayRollover — date: ${yesterday}`, error);

      return null;
    }
  });

// ─────────────────────────────────────────────────────────────
// createTip (HTTP Callable API para ejecutar desde Flutter)
// ─────────────────────────────────────────────────────────────
export const createTip = onCall(async (request) => {
  try {
    // ── 1. Verify user is authenticated ──────────────────────
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in to send a tip.");
    }

    const { amount, targetUserId } = request.data;

    // ── 2. Validate input fields ──────────────────────────────
    if (!amount || !targetUserId) {
      throw new HttpsError("invalid-argument", "Missing required fields: amount and targetUserId.");
    }

    if (amount <= 0) {
      throw new HttpsError("invalid-argument", "Amount must be greater than zero.");
    }

    // ── 3. Verify target user exists ──────────────────────────
    const targetUserSnap = await db.doc(`users/${targetUserId}`).get();
    if (!targetUserSnap.exists) {
      throw new HttpsError("not-found", `User ${targetUserId} not found.`);
    }

    // ── 4. Save tip to Firestore ──────────────────────────────
    // This automatically triggers onTipCreated
    const tipRef = await db.collection("tips").add({
      userId: targetUserId,       // the waiter/business receiving the tip
      senderUid: request.auth.uid,  // the user sending the tip
      amount,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ [createTip] tipId=${tipRef.id} | from=${request.auth.uid} | to=${targetUserId} | amount=$${amount}`);

    return { success: true, tipId: tipRef.id, message: "Tip recorded successfully." };

  } catch (error) {
    // Re-throw HttpsErrors as-is so the client gets the correct error code
    if (error instanceof HttpsError) throw error;

    console.error("❌ [createTip]", error);
    await mailer.sendErrorMail("createTip", error);

    throw new HttpsError("internal", "An unexpected error occurred while processing the tip.");
  }
});

// ─────────────────────────────────────────────────────────────
// sendOtp
// Generates a 6-digit OTP and sends it to the provided email.
//
// Request:  { email: string }
// Response: { success: true }
//
// - OTP expires in 10 minutes
// - Rate-limited: 1 request per minute per email
// ─────────────────────────────────────────────────────────────
const OTP_EXPIRES_MINUTES = 10;
const OTP_RATE_LIMIT_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

export const sendOtp = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { email } = req.body as { email?: string };

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: "A valid email address is required." });
      return;
    }

    const otpRef = db.doc(`otps/${email}`);
    const existing = await otpRef.get();

    if (existing.exists) {
      const createdAt = existing.data()?.createdAt?.toDate() as Date | undefined;
      if (createdAt) {
        const secondsElapsed = (Date.now() - createdAt.getTime()) / 1000;
        if (secondsElapsed < OTP_RATE_LIMIT_SECONDS) {
          const waitSeconds = Math.ceil(OTP_RATE_LIMIT_SECONDS - secondsElapsed);
          res.status(429).json({ error: `Please wait ${waitSeconds}s before requesting a new code.` });
          return;
        }
      }
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + OTP_EXPIRES_MINUTES * 60 * 1000);

    await otpRef.set({
      code: otp,
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      attempts: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const sent = await mailer.sendOtpMail(email, otp, OTP_EXPIRES_MINUTES);
    if (!sent) {
      res.status(500).json({ error: "Failed to send OTP email. Please try again." });
      return;
    }

    console.log(`✅ [sendOtp] OTP sent → ${email}`);
    res.json({ success: true, message: "Verification code sent to your email." });
  });
});

// ─────────────────────────────────────────────────────────────
// verifyOtp
// Validates the 6-digit OTP for a given email.
//
// Request:  { email: string, code: string }
// Response: { success: true }
//
// - Returns error if expired, incorrect, or max attempts reached
// - Deletes the OTP document on success
// ─────────────────────────────────────────────────────────────
export const verifyOtp = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { email, code } = req.body as { email?: string; code?: string };

    if (!email || !code) {
      res.status(400).json({ error: "email and code are required." });
      return;
    }

    if (!/^\d{6}$/.test(code)) {
      res.status(400).json({ error: "OTP must be a 6-digit number." });
      return;
    }

    const otpRef = db.doc(`otps/${email}`);

    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(otpRef);

        if (!snap.exists) {
          throw Object.assign(new Error("No verification code found for this email. Please request a new one."), { status: 404 });
        }

        const data = snap.data()!;
        const attempts: number = data.attempts ?? 0;
        const expiresAt = (data.expiresAt as admin.firestore.Timestamp).toDate();

        if (attempts >= OTP_MAX_ATTEMPTS) {
          tx.delete(otpRef);
          throw Object.assign(new Error("Too many failed attempts. Please request a new code."), { status: 429 });
        }

        if (new Date() > expiresAt) {
          tx.delete(otpRef);
          throw Object.assign(new Error("Verification code has expired. Please request a new one."), { status: 410 });
        }

        if (data.code !== code) {
          tx.update(otpRef, { attempts: admin.firestore.FieldValue.increment(1) });
          const remaining = OTP_MAX_ATTEMPTS - attempts - 1;
          throw Object.assign(new Error(`Incorrect code. ${remaining} attempt(s) remaining.`), { status: 400 });
        }

        tx.delete(otpRef);
      });
    } catch (err: any) {
      res.status(err.status ?? 500).json({ error: err.message });
      return;
    }

    console.log(`✅ [verifyOtp] OTP verified → ${email}`);
    res.json({ success: true, message: "Email verified successfully." });
  });
});
