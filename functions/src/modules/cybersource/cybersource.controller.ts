import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "../../config/firebase";
import { cybersourceSecrets } from "../../config/cybersource";
import { mailer } from "../../mailer_service";
import { customerFeeRepo } from "../payments/customer-fee.repository";
import { calculateCustomerFee } from "../payments/service-fee";
import { pricingService } from "../pricing/pricing.service";
import { readTargetOrigins } from "../../config/cybersource";
import {
  WalletNotAvailableError,
  cybersourceService,
  decodeTransientToken,
} from "./cybersource.service";
import { WalletSessionError, walletSessionRepo } from "./wallet-session.repository";
import type {
  ChargeTipRequest,
  ChargeTipResponse,
  ConsumerAuthentication,
  CreateSessionRequest,
  CreateSessionResponse,
  CybersourceWallet,
  Enroll3dsRequest,
  Enroll3dsResponse,
  Setup3dsRequest,
  Setup3dsResponse,
  WalletSession,
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

/** Maps a session-lookup failure to the callable error the FE expects. */
function sessionError(error: unknown): never {
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

/** The ACS posts the challenge result to this URL, so it must be one of ours. */
function assertAllowedReturnUrl(returnUrl: string): void {
  // localhost is the dev server, which may run over http; the browser is what
  // posts to it, so it never leaves the machine.
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(returnUrl);
  const allowed = readTargetOrigins();
  if (!isLocal && !allowed.some((origin) => returnUrl.startsWith(`${origin}/`))) {
    throw new HttpsError("invalid-argument", "returnUrl no permitido.");
  }
}

function clientIp(rawRequest: { headers: Record<string, unknown>; ip?: string } | undefined) {
  const forwarded = rawRequest?.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return rawRequest?.ip ?? null;
}

/**
 * Picks the authentication values, dropping the ones the issuer didn't send —
 * Firestore rejects `undefined`, and Cybersource doesn't want empty fields.
 */
function readAuthentication(
  result: { consumerAuthenticationInformation?: ConsumerAuthentication } | undefined
): ConsumerAuthentication {
  const info = result?.consumerAuthenticationInformation ?? {};
  const fields: (keyof ConsumerAuthentication)[] = [
    "cavv",
    "eciRaw",
    "xid",
    "directoryServerTransactionId",
    "paSpecificationVersion",
    "authenticationTransactionId",
    "indicator",
  ];
  const authentication: ConsumerAuthentication = {};
  for (const field of fields) {
    const value = info[field];
    if (typeof value === "string" && value.length > 0) authentication[field] = value;
  }
  return authentication;
}

function payerAuthError(result: { errorInformation?: { reason?: string; message?: string }; message?: string; status?: string; httpStatus: number }): string {
  return (
    result.errorInformation?.reason ??
    result.errorInformation?.message ??
    result.message ??
    result.status ??
    `http ${result.httpStatus}`
  );
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
      if (error instanceof WalletNotAvailableError) {
        // Not a failure: the merchant doesn't have this wallet enabled. The page
        // hides the wallet button and leaves the card option.
        console.warn(
          `⚠️ [createCybersourceSession] ${wallet} no disponible para el merchant | to=${targetUserId} | ${error.message}`
        );
        throw new HttpsError("failed-precondition", "wallet-unavailable");
      }
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
// setupCybersource3ds
// Decides whether this token needs EMV 3DS, per the VisaNet guide:
//   - Apple Pay, or Google Pay CRYPTOGRAM_3DS → device cryptogram, skip 3DS.
//   - Google Pay PAN_ONLY (card held in the Google account) → plain card,
//     run Payer Authentication.
//
// Request:  { sessionId, transientToken }
// Response: { mode: 'wallet' } | { mode: '3ds', accessToken, deviceDataCollectionUrl, referenceId }
// ─────────────────────────────────────────────────────────────
export const setupCybersource3ds = onCall(
  { secrets: cybersourceSecrets },
  async (request): Promise<Setup3dsResponse> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión para realizar un pago.");
    }
    const { sessionId, transientToken } = (request.data ?? {}) as Setup3dsRequest;
    if (!sessionId || !transientToken) {
      throw new HttpsError("invalid-argument", "sessionId y transientToken son requeridos.");
    }

    let session: WalletSession;
    try {
      session = await walletSessionRepo.loadForAuth(sessionId, request.auth.uid);
    } catch (error) {
      sessionError(error);
    }

    const info = decodeTransientToken(transientToken, session.wallet);

    if (info.skip3ds) {
      await walletSessionRepo.patchAuth(sessionId, {
        method: info.method,
        googlePayMode: info.googlePayMode,
        threeDs: "none",
      });
      console.log(
        `✅ [setupCybersource3ds] session=${sessionId} | ${info.method}${info.googlePayMode ? `/${info.googlePayMode}` : ""} | sin 3DS`
      );
      return { mode: "wallet" };
    }

    const setup = await cybersourceService.authenticationSetup({
      transientToken,
      referenceCode: sessionId,
    });
    const referenceId = setup.consumerAuthenticationInformation?.referenceId;
    const accessToken = setup.consumerAuthenticationInformation?.accessToken;
    const deviceDataCollectionUrl =
      setup.consumerAuthenticationInformation?.deviceDataCollectionUrl;

    if (!referenceId || !accessToken || !deviceDataCollectionUrl) {
      const reason = payerAuthError(setup);
      console.error(`❌ [setupCybersource3ds] session=${sessionId} | ${reason}`);
      await walletSessionRepo.markFailed(sessionId, `3ds-setup: ${reason}`, null);
      await reportError(`setupCybersource3ds — session=${sessionId}`, new Error(reason));
      throw new HttpsError(
        "unavailable",
        userMessage("No se pudo iniciar la verificación del pago.", new Error(reason))
      );
    }

    await walletSessionRepo.patchAuth(sessionId, {
      method: info.method,
      googlePayMode: info.googlePayMode,
      threeDs: "frictionless",
      referenceId,
    });

    console.log(
      `🔐 [setupCybersource3ds] session=${sessionId} | ${info.method}${info.googlePayMode ? `/${info.googlePayMode}` : ""} | 3DS requerido | to=${session.targetUserId}`
    );
    return { mode: "3ds", accessToken, deviceDataCollectionUrl, referenceId };
  }
);

// ─────────────────────────────────────────────────────────────
// enrollCybersource3ds
// Enrollment check. Either the issuer authenticates without friction, or it
// asks for a challenge that the customer completes in the step-up iframe.
//
// Request:  { sessionId, transientToken, returnUrl, browser }
// Response: { status: 'ok' } | { status: 'challenge', stepUpUrl, accessToken, pareq }
// ─────────────────────────────────────────────────────────────
export const enrollCybersource3ds = onCall(
  { secrets: cybersourceSecrets },
  async (request): Promise<Enroll3dsResponse> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión para realizar un pago.");
    }
    const { sessionId, transientToken, returnUrl, browser } = (request.data ??
      {}) as Enroll3dsRequest;
    if (!sessionId || !transientToken || !returnUrl) {
      throw new HttpsError(
        "invalid-argument",
        "sessionId, transientToken y returnUrl son requeridos."
      );
    }
    assertAllowedReturnUrl(returnUrl);

    let session: WalletSession;
    try {
      session = await walletSessionRepo.loadForAuth(sessionId, request.auth.uid);
    } catch (error) {
      sessionError(error);
    }
    if (!session.referenceId) {
      throw new HttpsError("failed-precondition", "Falta el paso previo de verificación.");
    }

    const info = decodeTransientToken(transientToken, session.wallet);
    const enrollment = await cybersourceService.checkEnrollment({
      transientToken,
      referenceCode: sessionId,
      totalAmount: session.customerPays,
      referenceId: session.referenceId,
      returnUrl,
      billTo: info.billTo,
      ipAddress: clientIp(request.rawRequest as never),
      browser: browser ?? {},
    });

    if (enrollment.status === "AUTHENTICATION_SUCCESSFUL") {
      const authentication = readAuthentication(enrollment);
      await walletSessionRepo.patchAuth(sessionId, {
        threeDs: "frictionless",
        authentication,
        authenticationTransactionId: authentication.authenticationTransactionId ?? null,
      });
      console.log(`✅ [enrollCybersource3ds] session=${sessionId} | frictionless`);
      return { status: "ok" };
    }

    if (enrollment.status === "PENDING_AUTHENTICATION") {
      const info3ds = enrollment.consumerAuthenticationInformation ?? {};
      if (!info3ds.stepUpUrl || !info3ds.accessToken) {
        const reason = payerAuthError(enrollment);
        await walletSessionRepo.markFailed(sessionId, `3ds-challenge: ${reason}`, null);
        throw new HttpsError("unavailable", userMessage("No se pudo verificar el pago.", new Error(reason)));
      }
      await walletSessionRepo.patchAuth(sessionId, {
        threeDs: "challenge",
        authenticationTransactionId: info3ds.authenticationTransactionId ?? null,
      });
      console.log(`🔐 [enrollCybersource3ds] session=${sessionId} | challenge`);
      return {
        status: "challenge",
        stepUpUrl: info3ds.stepUpUrl,
        accessToken: info3ds.accessToken,
        pareq: info3ds.pareq ?? "",
      };
    }

    const reason = payerAuthError(enrollment);
    console.warn(`⚠️ [enrollCybersource3ds] session=${sessionId} | ${reason}`);
    await walletSessionRepo.markFailed(sessionId, `3ds-enrollment: ${reason}`, null);
    throw new HttpsError("failed-precondition", "El banco no autorizó la verificación.");
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

    let session: WalletSession;
    try {
      session = await walletSessionRepo.claimForCharge(sessionId, uid);
    } catch (error) {
      sessionError(error);
    }

    const wallet: CybersourceWallet = session.wallet;
    const logCtx = `session=${sessionId} | from=${uid} | to=${session.targetUserId} | ${wallet} | RD$${session.customerPays}`;

    // After a challenge the final authentication values only exist once the
    // results call is made; a frictionless check already stored them.
    let authentication = session.authentication ?? null;
    if (session.threeDs === "challenge" && !authentication) {
      if (!session.authenticationTransactionId) {
        throw new HttpsError("failed-precondition", "Falta completar la verificación del banco.");
      }
      const results = await cybersourceService.validateAuthenticationResults({
        transientToken,
        referenceCode: sessionId,
        totalAmount: session.customerPays,
        authenticationTransactionId: session.authenticationTransactionId,
      });
      authentication = readAuthentication(results);
      if (!authentication.cavv && !authentication.authenticationTransactionId) {
        const reason = payerAuthError(results);
        console.warn(`⚠️ [chargeCybersourceTip] 3ds-results | ${logCtx} | ${reason}`);
        await walletSessionRepo.markFailed(sessionId, `3ds-results: ${reason}`, null);
        throw new HttpsError("failed-precondition", "No se pudo verificar el pago con el banco.");
      }
    }

    let payment;
    try {
      payment = await cybersourceService.chargeTransientToken({
        transientToken,
        totalAmount: session.customerPays,
        referenceCode: sessionId,
        targetUserId: session.targetUserId,
        senderUid: uid,
        wallet,
        authentication,
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
        authMethod: session.method ?? null,
        googlePayMode: session.googlePayMode ?? null,
        threeDS: session.threeDs ?? "none",
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
        ...(authentication ? { authentication } : {}),
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
