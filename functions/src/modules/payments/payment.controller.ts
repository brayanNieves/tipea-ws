import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "../../config/firebase";
import { buildStripeClient, stripeSecretKey } from "../../config/stripe";
import { mailer } from "../../mailer_service";
import { getUsdToDopRate } from "./exchange-rate.service";
import { paymentConfigRepo } from "./payment-config.repository";

// ─────────────────────────────────────────────────────────────
// createPaymentIntent
// Crea un Stripe PaymentIntent para procesar el pago de un tip.
//
// Request:  { amount: number, targetUserId: string }
//           amount en pesos dominicanos (ej: 500 = RD$500).
//
// La moneda de cobro depende del flag `appConfig/payment.chargeInUsd`:
//   - true  (default): convierte DOP → USD usando open.er-api.com
//                       (cache 24h + fallback) y cobra en USD.
//   - false:           cobra directamente en DOP, sin conversión.
//
// Response: { clientSecret: string, paymentIntentId: string }
//
// - Requiere autenticación Firebase
// - Lee STRIPE_SECRET_KEY desde el secret manager
// ─────────────────────────────────────────────────────────────
export const createPaymentIntent = onCall(
  { secrets: [stripeSecretKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión para realizar un pago.");
    }

    const { amount, targetUserId } = request.data as {
      amount?: number;
      targetUserId?: string;
    };

    if (!amount || typeof amount !== "number" || amount <= 0) {
      throw new HttpsError("invalid-argument", "El monto debe ser un número mayor a cero.");
    }

    if (!targetUserId) {
      throw new HttpsError("invalid-argument", "targetUserId es requerido.");
    }

    const targetUserSnap = await db.doc(`users/${targetUserId}`).get();
    if (!targetUserSnap.exists) {
      throw new HttpsError("not-found", `Usuario ${targetUserId} no encontrado.`);
    }

    let stripe;
    try {
      stripe = buildStripeClient();
    } catch {
      throw new HttpsError("failed-precondition", "Configuración de pagos no disponible.");
    }

    // Leer config (flag chargeInUsd). Default: true (cobra en USD).
    const { chargeInUsd } = await paymentConfigRepo.read();

    // Construir el payload del PaymentIntent según el modo.
    let paymentIntentPayload: {
      amount: number;
      currency: "usd" | "dop";
      automatic_payment_methods: { enabled: true };
      metadata: Record<string, string | number>;
    };
    let logSuffix: string;

    if (chargeInUsd) {
      // ── Modo USD: convertir DOP → USD ──────────────────────
      const { rate: dopRate, source: rateSource } = await getUsdToDopRate();
      const amountUsd = amount / dopRate;
      const amountInCents = Math.round(amountUsd * 100);

      // Stripe requiere mínimo US$0.50.
      if (amountInCents < 50) {
        throw new HttpsError(
          "invalid-argument",
          `El monto convertido (US$${amountUsd.toFixed(2)}) está por debajo del mínimo permitido (US$0.50).`
        );
      }

      paymentIntentPayload = {
        amount: amountInCents,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        metadata: {
          senderUid: request.auth.uid,
          targetUserId,
          amountPesos: amount,
          amountUsd: amountUsd.toFixed(2),
          dopRate: dopRate.toString(),
          rateSource,
          chargeMode: "usd",
        },
      };

      logSuffix = `RD$${amount} → US$${amountUsd.toFixed(2)} (rate=${dopRate}, src=${rateSource})`;
    } else {
      // ── Modo DOP: cobrar directo en pesos ──────────────────
      const amountInCentavos = Math.round(amount * 100);

      paymentIntentPayload = {
        amount: amountInCentavos,
        currency: "dop",
        automatic_payment_methods: { enabled: true },
        metadata: {
          senderUid: request.auth.uid,
          targetUserId,
          amountPesos: amount,
          chargeMode: "dop",
        },
      };

      logSuffix = `RD$${amount} (charged in DOP)`;
    }

    try {
      const paymentIntent = await stripe.paymentIntents.create(paymentIntentPayload);

      console.log(
        `✅ [createPaymentIntent] id=${paymentIntent.id} | from=${request.auth.uid} | to=${targetUserId} | ${logSuffix}`
      );

      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
      };
    } catch (error) {
      console.error("❌ [createPaymentIntent]", error);
      await mailer.sendErrorMail(
        `createPaymentIntent — from=${request.auth.uid} | to=${targetUserId} | ${logSuffix}`,
        error,
        true
      );
      const message =
        error instanceof Error
          ? error.message
          : "No se pudo crear el intento de pago. Intenta nuevamente.";
      throw new HttpsError("unknown", message);
    }
  }
);
