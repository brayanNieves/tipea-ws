import * as functions from "firebase-functions/v1";
import { db } from "../../config/firebase";
import { mailer } from "../../mailer_service";
import { FieldValue } from "firebase-admin/firestore";

// ─────────────────────────────────────────────────────────────
// onUserCreated
// Fires when a new user registers via Firebase Auth.
//
// What it does:
//   1. Creates the user profile in `users/{uid}` with the data
//      available from the Auth user (uid, email, displayName, etc.)
//   2. Creates their subscription record (Starter plan by default)
//   3. Notifies the admin of the new signup (name / email / phone)
//
// Anonymous users are customers on the tip page (signInAnonymously
// when they scan a QR). They are not staff: no profile, no
// subscription — only a "customer scanned a QR" notification.
// Their data lives in /tippers.
// ─────────────────────────────────────────────────────────────
export const onUserCreated = functions.auth.user().onCreate(async (user) => {
  try {
    // Backoffice-only users (created by createBackofficeUser, which writes
    // the profile first) don't receive tips: no plan, no subscription.
    const isAnonymous =
      user.providerData.length === 0 && !user.email && !user.phoneNumber;
    if (isAnonymous) {
      await db.collection("notifications").add({
        type: "user_signup",
        signupKind: "customer",
        message: "Cliente escaneó un QR (sin cuenta)",
        userId: user.uid,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
      console.log(`ℹ️ [onUserCreated] anonymous customer, skipping staff setup: ${user.uid}`);
      return null;
    }

    const existing = await db.doc(`users/${user.uid}`).get();
    if (existing.get("role") === "backoffice") {
      console.log(`ℹ️ [onUserCreated] backoffice user, skipping staff setup: ${user.uid}`);
      return null;
    }

    // The profile may already exist (bulk create / sign-up form writes it).
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const userName = str(existing.get("name")) ?? str(user.displayName);
    const email = str(user.email) ?? str(existing.get("email"));
    const phone = str(user.phoneNumber) ?? str(existing.get("phone"));
    const contact = email ?? phone;
    const who = userName ? (contact ? `${userName} (${contact})` : userName) : contact ?? user.uid;

    const renewalDate = new Date();
    renewalDate.setMonth(renewalDate.getMonth() + 1);

    const batch = db.batch();

    // Build user profile payload only with fields we actually know.
    // `merge: true` ensures we don't clobber a profile that another flow
    // (e.g. sign-up form) may have created moments earlier.
    const userPayload: Record<string, unknown> = {
      uid: user.uid,
      planId: "plan_starter",
      active: true,
      emailVerified: user.emailVerified ?? false,
      createdAt: FieldValue.serverTimestamp(),
    };

    if (user.email) userPayload.email = user.email;
    if (user.displayName) userPayload.name = user.displayName;
    if (user.phoneNumber) userPayload.phone = user.phoneNumber;

    batch.set(db.doc(`users/${user.uid}`), userPayload, { merge: true });

    batch.set(db.doc(`subscriptions/${user.uid}`), {
      userId: user.uid,
      planId: "plan_starter",
      status: "active",
      startDate: FieldValue.serverTimestamp(),
      renewalDate,
      canceledAt: null,
    });

    const notifRef = db.collection("notifications").doc();
    batch.set(notifRef, {
      type: "user_signup",
      signupKind: "staff",
      message: `Nuevo usuario: ${who}`,
      userName,
      email,
      phone,
      userId: user.uid,
      read: false,
      createdAt: FieldValue.serverTimestamp(),
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
