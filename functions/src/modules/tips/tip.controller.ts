import { onCall, HttpsError } from "firebase-functions/v2/https";
import { admin, db } from "../../config/firebase";
import { mailer } from "../../mailer_service";

// ─────────────────────────────────────────────────────────────
// createTip (HTTP Callable API)
// Called from Flutter to persist a new tip. The onTipCreated
// trigger then calculates commission, updates daily summaries,
// and emails the staff member.
// ─────────────────────────────────────────────────────────────
export const createTip = onCall(async (request) => {
  try {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in to send a tip.");
    }

    const { amount, targetUserId } = request.data;

    if (!amount || !targetUserId) {
      throw new HttpsError("invalid-argument", "Missing required fields: amount and targetUserId.");
    }

    if (amount <= 0) {
      throw new HttpsError("invalid-argument", "Amount must be greater than zero.");
    }

    const targetUserSnap = await db.doc(`users/${targetUserId}`).get();
    if (!targetUserSnap.exists) {
      throw new HttpsError("not-found", `User ${targetUserId} not found.`);
    }

    const tipRef = await db.collection("tips").add({
      userId: targetUserId,
      senderUid: request.auth.uid,
      amount,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(
      `✅ [createTip] tipId=${tipRef.id} | from=${request.auth.uid} | to=${targetUserId} | amount=$${amount}`
    );

    return { success: true, tipId: tipRef.id, message: "Tip recorded successfully." };
  } catch (error) {
    if (error instanceof HttpsError) throw error;

    console.error("❌ [createTip]", error);
    await mailer.sendErrorMail("createTip", error);

    throw new HttpsError("internal", "An unexpected error occurred while processing the tip.");
  }
});
