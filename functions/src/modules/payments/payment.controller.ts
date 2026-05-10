import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "../../config/firebase";
import { buildStripeClient, stripeSecretKey } from "../../config/stripe";
import { mailer } from "../../mailer_service";
import { getUsdToDopRate } from "./exchange-rate.service";
import { paymentConfigRepo } from "./payment-config.repository";
import { planCommissionFraction, pricingService } from "../pricing/pricing.service";
import type { PricingPaymentMethod } from "../pricing/pricing.types";

// ─────────────────────────────────────────────────────────────
// createPaymentIntent
// Crea un Stripe PaymentIntent para procesar el pago de un tip directo.
//
// Request:  { amount: number, targetUserId: string, paymentMethod?: 'card' | 'apple_pay' | 'google_pay' }
//           amount = monto VISIBLE en DOP (lo que el cliente selecciona).
//           El cliente paga exactamente ese monto — el pricing engine deja
//           el desglose interno (Stripe + plataforma + margen) registrado
//           en /tips.pricing y en metadata del PaymentIntent.
//
// Config (`appConfig/payment`):
//   - chargeInUsd (bool, default true)
//       true:  convierte DOP → USD con tipo de cambio (cache 24h) y cobra USD
//       false: cobra directamente en DOP
//
// Response shape:
//   {
//     clientSecret, paymentIntentId,
//     amountPesos,        // visibleAmount (DOP) — lo que el cliente paga
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

    // Resolve the staff's plan commission rate now so the pricing engine
    // can use it instead of the global default. Plans remain the source of
    // truth for per-staff commission tiers (Starter 7% / Pro 4% / Business 2%).
    const targetUserData = targetUserSnap.data() ?? {};
    const planId = (targetUserData as { planId?: string }).planId;
    let planCommissionPct: number | null = null;
    if (planId) {
      const planSnap = await db.doc(`plans/${planId}`).get();
      const planData = planSnap.data() as { commissionPct?: number } | undefined;
      if (typeof planData?.commissionPct === "number") {
        planCommissionPct = planData.commissionPct;
      }
    }
    const platformFeeFraction = planCommissionFraction(planCommissionPct);

    let stripe;
    try {
      stripe = buildStripeClient();
    } catch {
      throw new HttpsError("failed-precondition", "Configuración de pagos no disponible.");
    }

    // Customer pays exactly the visible amount — no uplift.
    const visibleAmountDop = amount;
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

    // Compute the centralized breakdown. Uses the same FX rate the engine
    // resolves internally (cache → API → fallback) and the staff's plan
    // commission tier as the platform fee.
    const pricing = pricingService.computeWithRate(
      visibleAmountDop,
      dopRate ?? (await getUsdToDopRate()).rate,
      channel,
      chargedCurrency,
      platformFeeFraction
    );

    // Build the PI payload now that we have the pricing block to embed.
    const baseMetadata: Record<string, string | number> = {
      senderUid: request.auth.uid,
      targetUserId,
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
        `✅ [createPaymentIntent] id=${paymentIntent.id} | from=${request.auth.uid} | to=${targetUserId} | ${logSuffix} | platform=${pricing.platformFee} | staffNet=${pricing.staffNet}`
      );

      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        // Original tip amount (DOP) — kept for back-compat with FE callers.
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
