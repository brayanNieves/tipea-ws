import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "../../config/firebase";
import { buildStripeClient, stripeSecretKey } from "../../config/stripe";
import { mailer } from "../../mailer_service";
import { getUsdToDopRate } from "./exchange-rate.service";

// ─────────────────────────────────────────────────────────────
// createPaymentIntent
// Crea un Stripe PaymentIntent para procesar el pago de un tip.
//
// Request:  { amount: number, targetUserId: string }
//           amount en pesos dominicanos (ej: 500 = RD$500).
//           El cobro se realiza en USD tras convertir con el tipo
//           de cambio USD→DOP obtenido de la API externa (cacheado 24h,
//           con fallback fijo si la API no responde).
// Response: { clientSecret: string, paymentIntentId: string }
//
// - Requiere autenticación Firebase
// - Lee STRIPE_SECRET_KEY desde .env
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

    // El amount llega en DOP; convertimos a USD usando el tipo de cambio.
    const { rate: dopRate, source: rateSource } = await getUsdToDopRate();
    const amountUsd = amount / dopRate;
    const amountInCents = Math.round(amountUsd * 100);

    // Stripe requiere un mínimo de US$0.50.
    if (amountInCents < 50) {
      throw new HttpsError(
        "invalid-argument",
        `El monto convertido (US$${amountUsd.toFixed(2)}) está por debajo del mínimo permitido (US$0.50).`
      );
    }

    try {
      const paymentIntent = await stripe.paymentIntents.create({
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
        },
      });

      console.log(
        `✅ [createPaymentIntent] id=${paymentIntent.id} | from=${request.auth.uid} | to=${targetUserId} | RD$${amount} → US$${amountUsd.toFixed(2)} (rate=${dopRate}, src=${rateSource})`
      );

      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
      };
    } catch (error) {
      console.error("❌ [createPaymentIntent]", error);
      await mailer.sendErrorMail(
        `createPaymentIntent — from=${request.auth.uid} | to=${targetUserId} | RD$${amount}`,
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
