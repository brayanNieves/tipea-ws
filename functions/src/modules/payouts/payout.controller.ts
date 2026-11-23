import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../config/firebase";
import { processPayout } from "./payout.service";

// ─────────────────────────────────────────────────────────────
// retryPayout — admin only
// For a payout that isn't "paid" (usually status "error" after
// onPayoutCreated failed). Never double-counts:
//   - every included tip already carries this payoutId → the processing
//     already happened (e.g. only the email failed): just mark it paid
//   - any tip was paid by ANOTHER payout → refuse, nothing changes
//   - otherwise → run the full processing now
// ─────────────────────────────────────────────────────────────
export const retryPayout = onCall(async (request) => {
  if (!request.auth?.token?.admin) {
    throw new HttpsError("permission-denied", "Solo el administrador puede hacer esto.");
  }
  const { payoutId } = (request.data ?? {}) as { payoutId?: string };
  if (!payoutId || typeof payoutId !== "string") {
    throw new HttpsError("invalid-argument", "Falta el pago.");
  }

  const payoutRef = db.doc(`payouts/${payoutId}`);
  const snap = await payoutRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Ese pago no existe.");
  const payout = snap.data() ?? {};
  if (payout.status === "paid") return { status: "already_paid" };

  const tipIds: string[] = Array.isArray(payout.tipsIncluded) ? payout.tipsIncluded : [];
  if (!tipIds.length) {
    throw new HttpsError("failed-precondition", "El pago no tiene propinas incluidas.");
  }

  const tipSnaps = await db.getAll(...tipIds.map((id) => db.doc(`tips/${id}`)));
  const missing = tipSnaps.filter((s) => !s.exists).length;
  if (missing > 0) {
    throw new HttpsError("failed-precondition", `${missing} propina(s) del pago ya no existen.`);
  }
  const mine = tipSnaps.filter((s) => s.get("payoutId") === payoutId).length;
  const elsewhere = tipSnaps.filter((s) => {
    const other = s.get("payoutId");
    return other !== payoutId && (!!other || s.get("status") === "paid");
  }).length;

  if (elsewhere > 0) {
    throw new HttpsError(
      "failed-precondition",
      `${elsewhere} propina(s) de este pago ya se pagaron en otro pago. Revísalo antes de marcarlo.`
    );
  }

  if (mine === tipIds.length) {
    await payoutRef.set(
      {
        status: "paid",
        errorMessage: FieldValue.delete(),
        errorAt: FieldValue.delete(),
        markedPaidBy: request.auth.uid,
        markedPaidAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { status: "marked_paid" };
  }

  try {
    await processPayout(payoutId, payout);
    await payoutRef.set(
      { markedPaidBy: request.auth.uid, markedPaidAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    return { status: "processed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await payoutRef
      .set({ status: "error", errorMessage: message, errorAt: FieldValue.serverTimestamp() }, { merge: true })
      .catch(() => {
        /* noop */
      });
    throw new HttpsError("internal", `No se pudo procesar: ${message}`);
  }
});
