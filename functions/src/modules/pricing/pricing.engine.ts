// ─────────────────────────────────────────────────────────────
// Pricing engine — funciones puras
//
// MODELO DE NEGOCIO: el fee se le cobra AL CLIENTE, encima de la propina.
// El staff SIEMPRE recibe el 100% de la propina — no se le descuenta
// comisión, ni Stripe, ni margen. `staffNet === tipAmount`, siempre.
//
//   visibleAmount (lo que paga el cliente) = tipAmount + customerFee
//   staffNet                               = tipAmount
//   profitability                          = customerFee
//
// El costo de procesamiento se sigue calculando SOLO como dato informativo
// del ledger (para reconciliar contra Stripe); no reduce el pago al staff.
//
// Sin efectos secundarios ni I/O — el tipo de cambio se inyecta para que
// este módulo quede puro y testeable.
// ─────────────────────────────────────────────────────────────

import type {
  PricingBreakdown,
  PricingCurrency,
  PricingPaymentMethod,
} from "./pricing.types";

// Pricing estándar de tarjeta internacional de Stripe.
export const STRIPE_PCT_USD = 0.029;
export const STRIPE_FIXED_USD = 0.30;
export const STRIPE_CONVERSION_PCT = 0.01;

// Comisión al staff. 0 — el fee lo paga el cliente, no el staff.
// No subir de 0 sin cambiar el modelo de negocio completo.
export const PLATFORM_FEE_PCT = 0;

// Usado solo cuando el servicio de FX no logra producir una tasa fresca.
export const DEFAULT_DOP_PER_USD = 59.25;

/** Redondea a 2 decimales (centavos DOP). Evita drift de float. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Calcula el desglose de una propina.
 *
 * @param tipAmountDop    la propina — lo que recibe el staff (DOP). 100%.
 * @param fxRate          DOP por USD (de exchange-rate.service)
 * @param paymentMethod   'card' | 'apple_pay' | 'google_pay' | 'wallet' | 'dev'
 * @param chargedCurrency moneda del PaymentIntent en Stripe. Las propinas
 *                        desde wallet fuerzan 'dop' porque no hay llamada a
 *                        Stripe al momento de la propina.
 * @param customerFeeDop  fee cobrado al cliente encima de la propina (DOP).
 *                        Se calcula con `calculateCustomerFee` desde
 *                        /config/customerFee.
 */
export function computeBreakdown(
  tipAmountDop: number,
  fxRate: number,
  paymentMethod: PricingPaymentMethod,
  chargedCurrency: PricingCurrency = "usd",
  customerFeeDop: number = 0
): PricingBreakdown {
  if (!Number.isFinite(tipAmountDop) || tipAmountDop <= 0) {
    throw new Error(`computeBreakdown: tipAmount inválido=${tipAmountDop}`);
  }
  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error(`computeBreakdown: fxRate inválido=${fxRate}`);
  }
  if (!Number.isFinite(customerFeeDop) || customerFeeDop < 0) {
    throw new Error(`computeBreakdown: customerFee inválido=${customerFeeDop}`);
  }

  const walletUsed = paymentMethod === "wallet";

  // Lo que se le cobra al cliente: propina + fee.
  const visibleAmount = round2(tipAmountDop + customerFeeDop);

  let stripeProcessingFee = 0;
  let stripeConversionFee = 0;

  if (!walletUsed) {
    // Informativo: el costo de Stripe se calcula sobre el total cobrado,
    // pero NO se le descuenta al staff — lo absorbe TipApp.
    const amountUsd = visibleAmount / fxRate;
    const processingUsd = amountUsd * STRIPE_PCT_USD + STRIPE_FIXED_USD;
    stripeProcessingFee = round2(processingUsd * fxRate);

    if (chargedCurrency === "usd") {
      const conversionUsd = amountUsd * STRIPE_CONVERSION_PCT;
      stripeConversionFee = round2(conversionUsd * fxRate);
    }
  }

  const totalProcessingCost = round2(stripeProcessingFee + stripeConversionFee);

  // El staff recibe el 100% de la propina. Sin excepciones.
  const staffNet = round2(tipAmountDop);

  return {
    tipAmount: round2(tipAmountDop),
    customerFee: round2(customerFeeDop),
    visibleAmount,
    stripeProcessingFee,
    stripeConversionFee,
    // Comisión al staff — siempre 0 en este modelo.
    platformFee: 0,
    marginSafety: 0,
    staffNet,
    totalProcessingCost,
    // El ingreso de TipApp en esta transacción es el fee cobrado al cliente.
    profitability: round2(customerFeeDop),
    exchangeRate: fxRate,
    currency: walletUsed ? "dop" : chargedCurrency,
    paymentMethod,
    walletUsed,
  };
}
