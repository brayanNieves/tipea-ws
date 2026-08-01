import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "../../config/firebase";
import { buildStripeClient, stripeSecretKey } from "../../config/stripe";
import { mailer } from "../../mailer_service";
import { getUsdToDopRate } from "./exchange-rate.service";
import { paymentConfigRepo } from "./payment-config.repository";
import { customerFeeRepo } from "./customer-fee.repository";
import { calculateCustomerFee } from "./service-fee";
import { pricingService } from "../pricing/pricing.service";
import type { PricingPaymentMethod } from "../pricing/pricing.types";

// ─────────────────────────────────────────────────────────────
// createPaymentIntent
// Crea un Stripe PaymentIntent para procesar el pago de un tip directo.
//
// Request:  { amount: number, targetUserId: string, paymentMethod?: 'card' | 'apple_pay' | 'google_pay' }
//           amount = la PROPINA en DOP (lo que el cliente selecciona y lo que
//           el staff recibe COMPLETO — el 100%).
//
//           El cliente paga la propina + un fee de servicio configurado en
//           /config/customerFee (editable en el backoffice: /admin/fee-config).
//           El total cobrado a Stripe es `customerPays = amount + feeCharged`.
//           El fee se recalcula SIEMPRE en el servidor; nunca se confía en un
//           total enviado por el cliente.
//
// Config (`appConfig/payment`):
//   - chargeInUsd (bool, default true)
//       true:  convierte DOP → USD con tipo de cambio (cache 24h) y cobra USD
//       false: cobra directamente en DOP
//
// Response shape:
//   {
//     clientSecret, paymentIntentId,
//     tipAmount,          // la propina (DOP) — lo que recibe el staff, 100%
//     feeCharged,         // fee cobrado al cliente (DOP)
//     customerPays,       // tipAmount + feeCharged — lo que se cobra a Stripe
//     amountPesos,        // === customerPays (back-compat)
//     displayAmount,      // monto a mostrar en Apple Pay / UI (en displayCurrency)
//     displayCurrency,    // "USD" | "DOP"
//     chargedCurrency,    // "usd" | "dop" — lo que Stripe cobra
//     dopRate?, rateSource?, amountUsd? // solo en modo USD
//     pricing,            // bloque opaco — el FE lo adjunta al /tips doc tal cual
//   }
//
// El FE NO debe mostrar `pricing` al usuario. Es solo para el ledger.
// ─────────────────────────────────────────────────────────────
export const createPaymentIntent = onCall(
  { secrets: [stripeSecretKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión para realizar un pago.");
    }

    const { amount, targetUserId, paymentMethod } = request.data as {
      amount?: number;
      targetUserId?: string;
      paymentMethod?: PricingPaymentMethod;
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

    // `amount` es la PROPINA (lo que recibe el staff, 100%). El cliente paga
    // la propina + el fee configurado en /config/customerFee. El servidor es
    // la autoridad: recalcula el fee acá, nunca confía en un total del cliente.
    const tipAmountDop = amount;
    const feeConfig = await customerFeeRepo.read();
    const fee = calculateCustomerFee(
      tipAmountDop,
      feeConfig.percentageFee,
      feeConfig.fixedFee
    );
    const visibleAmountDop = fee.customerPays;

    const { chargeInUsd } = await paymentConfigRepo.read();

    // Defaults to 'card'; FE can pass 'apple_pay' / 'google_pay' so analytics
    // attributes the channel correctly. Wallet/dev are not valid here.
    const channel: PricingPaymentMethod =
      paymentMethod === "apple_pay" || paymentMethod === "google_pay" ? paymentMethod : "card";

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
      // ── Modo USD: convertir DOP → USD ──────────────────────
      const rateInfo = await getUsdToDopRate();
      dopRate = rateInfo.rate;
      rateSource = rateInfo.source;
      amountUsd = visibleAmountDop / dopRate;
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
      logSuffix = `RD$${visibleAmountDop} → US$${amountUsd.toFixed(2)} (rate=${dopRate}, src=${rateSource})`;
    } else {
      // ── Modo DOP: cobrar directo en pesos ──────────────────
      const amountInCentavos = Math.round(visibleAmountDop * 100);
      displayAmount = Number(visibleAmountDop.toFixed(2));
      displayCurrency = "DOP";
      chargedCurrency = "dop";
      logSuffix = `RD$${visibleAmountDop} (charged in DOP)`;

      paymentIntentPayload = {
        amount: amountInCentavos,
        currency: "dop",
        automatic_payment_methods: { enabled: true },
        metadata: {},
      };
    }

    // Desglose centralizado. El engine recibe la PROPINA + el fee al cliente;
    // `staffNet` sale siempre igual a la propina (100%).
    const pricing = pricingService.computeWithRate(
      tipAmountDop,
      dopRate ?? (await getUsdToDopRate()).rate,
      channel,
      chargedCurrency,
      fee.totalFee
    );

    // Build the PI payload now that we have the pricing block to embed.
    const baseMetadata: Record<string, string | number> = {
      senderUid: request.auth.uid,
      targetUserId,
      tipAmount: pricing.tipAmount,
      customerFee: pricing.customerFee,
      visibleAmount: pricing.visibleAmount,
      stripeProcessingFee: pricing.stripeProcessingFee,
      stripeConversionFee: pricing.stripeConversionFee,
      platformFee: pricing.platformFee,
      marginSafety: pricing.marginSafety,
      staffNet: pricing.staffNet,
      profitability: pricing.profitability,
      exchangeRate: pricing.exchangeRate,
      paymentMethod: pricing.paymentMethod,
      chargeMode: chargedCurrency,
    };

    if (chargeInUsd) {
      const amountInCents = Math.round((amountUsd as number) * 100);
      paymentIntentPayload = {
        amount: amountInCents,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        metadata: {
          ...baseMetadata,
          amountUsd: (amountUsd as number).toFixed(2),
          dopRate: (dopRate as number).toString(),
          rateSource: rateSource as string,
        },
      };
    } else {
      const amountInCentavos = Math.round(visibleAmountDop * 100);
      paymentIntentPayload = {
        amount: amountInCentavos,
        currency: "dop",
        automatic_payment_methods: { enabled: true },
        metadata: baseMetadata,
      };
    }

    try {
      const paymentIntent = await stripe.paymentIntents.create(paymentIntentPayload);

      console.log(
        `✅ [createPaymentIntent] id=${paymentIntent.id} | from=${request.auth.uid} | to=${targetUserId} | ${logSuffix} | tip=${pricing.tipAmount} | fee=${pricing.customerFee} | staffNet=${pricing.staffNet}`
      );

      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        // ── Desglose del fee al cliente ────────────────────────
        // El staff recibe tipAmount completo; el cliente paga customerPays.
        tipAmount: fee.tipAmount,
        feeCharged: fee.totalFee,
        feePercentageAmount: fee.percentageAmount,
        feeFixed: fee.fixedFee,
        customerPays: fee.customerPays,
        // Total cobrado al cliente (DOP) — se mantiene el nombre por
        // back-compat con callers del FE que ya lo leían.
        amountPesos: visibleAmountDop,
        // Lo que el frontend DEBE pasar a Apple Pay / Stripe Elements.
        displayAmount,
        displayCurrency,
        chargedCurrency,
        // Información de conversión (solo presente en modo USD).
        amountUsd: amountUsd !== null ? Number(amountUsd.toFixed(2)) : null,
        dopRate,
        rateSource,
        // Bloque opaco de pricing — el FE lo adjunta directo al /tips doc.
        pricing,
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
