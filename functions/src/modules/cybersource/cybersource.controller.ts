import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "../../config/firebase";
import { cybersourceSecrets } from "../../config/cybersource";
import { mailer } from "../../mailer_service";
import { customerFeeRepo } from "../payments/customer-fee.repository";
import { calculateCustomerFee } from "../payments/service-fee";
import { pricingService } from "../pricing/pricing.service";
import { cybersourceService } from "./cybersource.service";
import { WalletSessionError, walletSessionRepo } from "./wallet-session.repository";
import type {
  ChargeTipRequest,
  ChargeTipResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  CybersourceWallet,
} from "./cybersource.types";
import { FieldValue } from "firebase-admin/firestore";

const MAX_COMMENT_LENGTH = 500;

// Local runs (firebase emulators) get the real reason back and don't email.
const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === "true";

async function reportError(context: string, error: unknown): Promise<void> {
  if (IS_EMULATOR) return;
  await mailer.sendErrorMail(context, error, true);
}

function userMessage(fallback: string, error: unknown): string {
  if (!IS_EMULATOR) return fallback;
  return `${fallback} [emulator: ${error instanceof Error ? error.message : String(error)}]`;
}

// ─────────────────────────────────────────────────────────────
// createCybersourceSession
// Starts an Apple Pay / Google Pay tip charged through Cybersource
// (Unified Checkout). Used for customers in the Dominican Republic;
// everyone else goes through Stripe (createPaymentIntent).
//
// Request:  { amount /* tip in DOP */, targetUserId, wallet: 'apple_pay' | 'google_pay' }
// Response: { sessionId, captureContext, tipAmount, feeCharged, customerPays }
//
// The fee and the total are computed here and stored in the session.
// chargeCybersourceTip charges exactly that total.
// ─────────────────────────────────────────────────────────────
export const createCybersourceSession = onCall(
  { secrets: cybersourceSecrets },
  async (request): Promise<CreateSessionResponse> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión para realizar un pago.");
    }

    const { amount, targetUserId, wallet } = (request.data ?? {}) as CreateSessionRequest;

    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      throw new HttpsError("invalid-argument", "El monto debe ser un número mayor a cero.");
    }
    if (!targetUserId) {
      throw new HttpsError("invalid-argument", "targetUserId es requerido.");
    }
    if (wallet !== "apple_pay" && wallet !== "google_pay") {
      throw new HttpsError("invalid-argument", "wallet debe ser apple_pay o google_pay.");
    }

    const targetUserSnap = await db.doc(`users/${targetUserId}`).get();
    if (!targetUserSnap.exists || targetUserSnap.get("active") === false) {
      throw new HttpsError("not-found", `Usuario ${targetUserId} no encontrado.`);
    }

    const feeConfig = await customerFeeRepo.read();
    const fee = calculateCustomerFee(amount, feeConfig.percentageFee, feeConfig.fixedFee);

    // Charged in DOP, so the FX rate is irrelevant to the breakdown.
    const pricing = pricingService.computeWithRate(
      amount,
      1,
      wallet,
      "dop",
      fee.totalFee,
      "cybersource"
    );

    const sessionRef = walletSessionRepo.newRef();

    try {
      const captureContext = await cybersourceService.createCaptureContext(
        fee.customerPays,
        wallet
      );

      await walletSessionRepo.create(sessionRef, {
        uid: request.auth.uid,
        targetUserId,
        wallet,
        tipAmount: fee.tipAmount,
        feeCharged: fee.totalFee,
        customerPays: fee.customerPays,
        currency: "DOP",
        pricing,
      });

      console.log(
        `✅ [createCybersourceSession] session=${sessionRef.id} | from=${request.auth.uid} | to=${targetUserId} | ${wallet} | tip=${fee.tipAmount} | fee=${fee.totalFee} | total=RD$${fee.customerPays}`
      );

      return {
        sessionId: sessionRef.id,
        captureContext,
        tipAmount: fee.tipAmount,
        feeCharged: fee.totalFee,
        customerPays: fee.customerPays,
      };
    } catch (error) {
      console.error("❌ [createCybersourceSession]", error);
      await reportError(
        `createCybersourceSession — from=${request.auth.uid} | to=${targetUserId} | ${wallet}`,
        error
      );
      throw new HttpsError(
        "unavailable",
        userMessage("No se pudo iniciar el pago. Intenta nuevamente.", error)
      );
    }
  }
);

// ─────────────────────────────────────────────────────────────
// chargeCybersourceTip
// Charges the transient token produced by Unified Checkout for a session
// created by createCybersourceSession and, once AUTHORIZED, writes the /tips
// doc with the Admin SDK (same shape as the Stripe flow).
//
// Request:  { sessionId, transientToken, songRequest?, rating?, comment? }
// Response: { tipId }
// ─────────────────────────────────────────────────────────────
export const chargeCybersourceTip = onCall(
  { secrets: cybersourceSecrets },
  async (request): Promise<ChargeTipResponse> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión para realizar un pago.");
    }
    const uid = request.auth.uid;

    const { sessionId, transientToken, songRequest, rating, comment } = (request.data ??
      {}) as ChargeTipRequest;

    if (!sessionId || typeof sessionId !== "string") {
      throw new HttpsError("invalid-argument", "sessionId es requerido.");
    }
    if (!transientToken || typeof transientToken !== "string") {
      throw new HttpsError("invalid-argument", "transientToken es requerido.");
    }

    let session;
    try {
      session = await walletSessionRepo.claimForCharge(sessionId, uid);
    } catch (error) {
      if (error instanceof WalletSessionError) {
        switch (error.code) {
          case "NOT_FOUND":
            throw new HttpsError("not-found", "Sesión de pago no encontrada.");
          case "FORBIDDEN":
            throw new HttpsError("permission-denied", "La sesión de pago no te pertenece.");
          case "USED":
            throw new HttpsError("failed-precondition", "Esta sesión de pago ya fue usada.");
          case "EXPIRED":
            throw new HttpsError("deadline-exceeded", "La sesión de pago expiró.");
        }
      }
      throw error;
    }

    const wallet: CybersourceWallet = session.wallet;
    const logCtx = `session=${sessionId} | from=${uid} | to=${session.targetUserId} | ${wallet} | RD$${session.customerPays}`;

    let payment;
    try {
      payment = await cybersourceService.chargeTransientToken({
        transientToken,
        totalAmount: session.customerPays,
        referenceCode: sessionId,
        targetUserId: session.targetUserId,
        senderUid: uid,
      });
    } catch (error) {
      // Network error: we don't know whether Cybersource charged. Leave the
      // session in `charging` for manual reconciliation.
      console.error(`❌ [chargeCybersourceTip] ${logCtx}`, error);
      await reportError(`chargeCybersourceTip (network) — ${logCtx}`, error);
      throw new HttpsError(
        "unavailable",
        userMessage("No se pudo procesar el pago. Intenta nuevamente.", error)
      );
    }

    if (payment.status !== "AUTHORIZED") {
      const reason =
        payment.errorInformation?.reason ??
        payment.errorInformation?.message ??
        payment.reason ??
        payment.message ??
        payment.status ??
        `http ${payment.httpStatus}`;
      console.warn(`⚠️ [chargeCybersourceTip] declined | ${logCtx} | ${reason}`);
      await walletSessionRepo.markFailed(sessionId, reason, payment.id ?? null);
      throw new HttpsError("failed-precondition", "El pago fue rechazado.");
    }

    const paymentId = payment.id ?? null;
    const tipRef = db.collection("tips").doc();
    const trimmedComment =
      typeof comment === "string" ? comment.trim().slice(0, MAX_COMMENT_LENGTH) || null : null;
    const validRating = typeof rating === "number" && rating >= 1 && rating <= 5 ? rating : null;

    try {
      const batch = db.batch();
      batch.set(tipRef, {
        userId: session.targetUserId,
        senderUid: uid,
        // `amount` = the tip: what staff receive, 100% of it.
        amount: session.tipAmount,
        tipAmount: session.tipAmount,
        feeCharged: session.feeCharged,
        customerPaid: session.customerPays,
        source: "qr",
        status: "paid",
        payoutId: null,
        createdAt: FieldValue.serverTimestamp(),
        stripePaymentIntentId: null,
        paymentProcessor: "cybersource",
        cybersourcePaymentId: paymentId,
        paymentMethod: wallet,
        pricing: session.pricing,
        songRequest: songRequest && typeof songRequest === "object" ? songRequest : null,
        rating: validRating,
        comment: trimmedComment,
        ratedAt: validRating ? FieldValue.serverTimestamp() : null,
      });
      batch.update(walletSessionRepo.ref(sessionId), {
        status: "paid",
        paymentId,
        tipId: tipRef.id,
      });
      await batch.commit();
    } catch (error) {
      // Charged but the tip wasn't recorded — must be reconciled by hand.
      console.error(`❌ [chargeCybersourceTip] charged but tip write failed | ${logCtx} | payment=${paymentId}`, error);
      await walletSessionRepo.ref(sessionId).update({ paymentId }).catch(() => {});
      await reportError(
        `chargeCybersourceTip COBRADO SIN TIP — ${logCtx} | payment=${paymentId}`,
        error
      );
      throw new HttpsError("internal", "El pago se procesó pero no se pudo registrar la propina.");
    }

    console.log(`✅ [chargeCybersourceTip] tip=${tipRef.id} | payment=${paymentId} | ${logCtx}`);
    return { tipId: tipRef.id };
  }
);
