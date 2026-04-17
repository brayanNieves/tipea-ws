import * as functions from "firebase-functions/v1";
import { admin, db } from "../../config/firebase";
import { mailer } from "../../mailer_service";

// ─────────────────────────────────────────────────────────────
// onUserCreated
// Fires when a new user registers via Firebase Auth.
//
// What it does:
//   1. Creates their subscription record (Starter plan by default)
//   2. Notifies the admin of the new signup
// ─────────────────────────────────────────────────────────────
export const onUserCreated = functions.auth.user().onCreate(async (user) => {
  try {
    const renewalDate = new Date();
    renewalDate.setMonth(renewalDate.getMonth() + 1);

    const batch = db.batch();

    batch.set(db.doc(`subscriptions/${user.uid}`), {
      userId: user.uid,
      planId: "plan_starter",
      status: "active",
      startDate: admin.firestore.FieldValue.serverTimestamp(),
      renewalDate,
      canceledAt: null,
    });

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
    await mailer.sendErrorMail(`onUserCreated — uid: ${user.uid}`, error);
    return null;
  }
});
