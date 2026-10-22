import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { walletSessionRepo } from "./wallet-session.repository";
import { logGatewayCall } from "./payment-log.repository";
import type { WalletSession } from "./cybersource.types";

// ─────────────────────────────────────────────────────────────
// logPaymentSheetEvent
// The tip page reports what happened to the Apple Pay / Google Pay sheet,
// which never reaches the gateway when the customer backs out:
//   - sheet_cancelled: the sheet was opened and closed without paying
//   - sheet_error:     the sheet failed to open or errored
// Lets the backoffice tell "saw the button" from "opened the wallet".
//
// Request: { sessionId, event, detail? }
// ─────────────────────────────────────────────────────────────

const EVENTS = ["sheet_cancelled", "sheet_error"] as const;
type WalletEvent = (typeof EVENTS)[number];

export const logPaymentSheetEvent = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const { sessionId, event, detail } = (request.data ?? {}) as {
    sessionId?: string;
    event?: string;
    detail?: string;
  };
  if (!sessionId || !EVENTS.includes(event as WalletEvent)) {
    throw new HttpsError("invalid-argument", "sessionId and a valid event are required.");
  }

  const ref = walletSessionRepo.ref(sessionId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Session not found.");
  const session = snap.data() as WalletSession;
  if (session.uid !== request.auth.uid) throw new HttpsError("permission-denied", "Not your session.");

  const safeDetail = typeof detail === "string" ? detail.slice(0, 300) : null;
  await ref.update(
    event === "sheet_cancelled"
      ? { sheetCancelledAt: FieldValue.serverTimestamp(), sheetCancels: FieldValue.increment(1) }
      : { sheetErrorAt: FieldValue.serverTimestamp(), sheetError: safeDetail }
  );

  logGatewayCall({
    sessionId,
    step: "wallet_sheet",
    httpStatus: null,
    response: { event, detail: safeDetail },
    uid: request.auth.uid,
    targetUserId: session.targetUserId,
    wallet: session.wallet,
    amount: session.customerPays,
  });

  return { ok: true };
});
