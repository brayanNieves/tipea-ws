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
// Config (`appConfig/payment`):
//   - chargeInUsd (bool, default true)
//       true:  convierte DOP → USD con tipo de cambio (cache 24h) y cobra USD
//       false: cobra directamente en DOP
//   - feePct (number, default 7)
//       fee de pasarela cobrado AL CLIENTE sobre el monto del tip.
//       Cliente paga `amount * (1 + feePct/100)`. 0 = sin fee.
//
// Response shape:
//   {
//     clientSecret, paymentIntentId,
//     amountPesos,        // tip original (DOP)
//     feePct, feeAmount,  // fee aplicado
//     totalChargedDop,    // total en DOP (tip + fee)
//     displayAmount,      // monto a mostrar en Apple Pay / UI (en displayCurrency)
//     displayCurrency,    // "USD" | "DOP"
//     chargedCurrency,    // "usd" | "dop" — lo que Stripe cobra
//     dopRate?, rateSource? // solo en modo USD
//   }
//
// IMPORTANTE: el frontend DEBE usar `displayAmount` y `displayCurrency`
// cuando arma el Apple Pay PaymentRequest, para que el monto mostrado
// al usuario coincida con el que Stripe va a cobrar. De otro modo el
// usuario firma por un monto y se le cobra otro.
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

    // Leer config (chargeInUsd + feePct).
    const { chargeInUsd, feePct } = await paymentConfigRepo.read();

    // Fee de pasarela: cliente paga amount + feePct%.
    const feeMultiplier = 1 + feePct / 100;
    const amountWithFeeDop = amount * feeMultiplier;
    const feeAmountDop = amountWithFeeDop - amount;

    // Valores computados según el modo. Los declaramos up-front para
    // poder devolverlos en la respuesta.
    let paymentIntentPayload: {
      amount: number;
      currency: "usd" | "dop";
      automatic_payment_methods: { enabled: true };
      metadata: Record<string, string | number>;
    };
    let displayAmount: number;
    let displayCurrency: "USD" | "DOP";
    let chargedCurrency: "usd" | "dop";
    let dopRate: number | null = null;
    let rateSource: string | null = null;
    let amountUsd: number | null = null;
    let logSuffix: string;

    if (chargeInUsd) {
      // ── Modo USD: convertir DOP (con fee) → USD ────────────
      const rateInfo = await getUsdToDopRate();
      dopRate = rateInfo.rate;
      rateSource = rateInfo.source;
      amountUsd = amountWithFeeDop / dopRate;
      const amountInCents = Math.round(amountUsd * 100);

      if (amountInCents < 50) {
        throw new HttpsError(
          "invalid-argument",
          `El monto convertido (US$${amountUsd.toFixed(2)}) está por debajo del mínimo permitido (US$0.50).`
        );
      }

      displayAmount = Number(amountUsd.toFixed(2));
      displayCurrency = "USD";
      chargedCurrency = "usd";

      paymentIntentPayload = {
        amount: amountInCents,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        metadata: {
          senderUid: request.auth.uid,
          targetUserId,
          amountPesos: amount,
          feePct: feePct.toString(),
          feeAmount: feeAmountDop.toFixed(2),
          totalChargedDop: amountWithFeeDop.toFixed(2),
          amountUsd: amountUsd.toFixed(2),
          dopRate: dopRate.toString(),
          rateSource,
          chargeMode: "usd",
        },
      };

      logSuffix =
        `RD$${amount} + ${feePct}% = RD$${amountWithFeeDop.toFixed(2)} ` +
        `→ US$${amountUsd.toFixed(2)} (rate=${dopRate}, src=${rateSource})`;
    } else {
      // ── Modo DOP: cobrar directo en pesos (con fee) ────────
      const amountInCentavos = Math.round(amountWithFeeDop * 100);

      displayAmount = Number(amountWithFeeDop.toFixed(2));
      displayCurrency = "DOP";
      chargedCurrency = "dop";

      paymentIntentPayload = {
        amount: amountInCentavos,
        currency: "dop",
        automatic_payment_methods: { enabled: true },
        metadata: {
          senderUid: request.auth.uid,
          targetUserId,
          amountPesos: amount,
          feePct: feePct.toString(),
          feeAmount: feeAmountDop.toFixed(2),
          totalChargedDop: amountWithFeeDop.toFixed(2),
          chargeMode: "dop",
        },
      };

      logSuffix = `RD$${amount} + ${feePct}% = RD$${amountWithFeeDop.toFixed(2)} (charged in DOP)`;
    }

    try {
      const paymentIntent = await stripe.paymentIntents.create(paymentIntentPayload);

      console.log(
        `✅ [createPaymentIntent] id=${paymentIntent.id} | from=${request.auth.uid} | to=${targetUserId} | ${logSuffix}`
      );

      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        // Monto original y fee (para mostrar desglose en la UI si se quiere)
        amountPesos: amount,
        feePct,
        feeAmount: Number(feeAmountDop.toFixed(2)),
        totalChargedDop: Number(amountWithFeeDop.toFixed(2)),
        // Lo que el frontend DEBE pasar a Apple Pay / Stripe Elements
        displayAmount,
        displayCurrency,
        chargedCurrency,
        // Información de conversión (solo presente en modo USD)
        amountUsd: amountUsd !== null ? Number(amountUsd.toFixed(2)) : null,
        dopRate,
        rateSource,
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
