import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { mailer } from "../../mailer_service";
import { FieldValue } from "firebase-admin/firestore";
import { processPayout } from "./payout.service";

// ─────────────────────────────────────────────────────────────
// onPayoutCreated
// Fires every time a bank transfer to a user is recorded. The work lives in
// processPayout (payout.service.ts). On failure the payout is left in
// status "error" with errorMessage, and the admin can retry it from the
// backoffice with the retryPayout callable.
// ─────────────────────────────────────────────────────────────
export const onPayoutCreated = onDocumentCreated(
  { document: "payouts/{payoutId}" },
  async (event) => {
    const snap = event.data;
    if (!snap) return null;

    const payout = snap.data();
    const payoutId = event.params.payoutId;

    try {
      await processPayout(payoutId, payout);
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
          errorAt: FieldValue.serverTimestamp(),
        })
        .catch(() => {
          /* noop */
        });

      await mailer.sendErrorMail(`onPayoutCreated — payoutId: ${payoutId}`, error);

      return null;
    }
  }
);
