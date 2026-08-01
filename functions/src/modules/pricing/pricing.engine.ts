// ─────────────────────────────────────────────────────────────
// Pricing engine — pure functions
//
// BUSINESS MODEL: the fee is charged to the CUSTOMER, on top of the tip.
// Staff ALWAYS receive 100% of the tip — no commission, no Stripe cut, no
// margin buffer is ever deducted. `staffNet === tipAmount`, always.
//
//   visibleAmount (what the customer pays) = tipAmount + customerFee
//   staffNet                               = tipAmount
//   profitability                          = customerFee
//
// Processing cost is still computed, but ONLY as ledger information (to
// reconcile against Stripe); it never reduces the staff payout.
//
// No side effects, no I/O — the FX rate is injected so this module stays
// pure and unit-testable.
// ─────────────────────────────────────────────────────────────

import type {
  PricingBreakdown,
  PricingCurrency,
  PricingPaymentMethod,
} from "./pricing.types";

// Stripe's standard international card pricing.
export const STRIPE_PCT_USD = 0.029;
export const STRIPE_FIXED_USD = 0.30;
export const STRIPE_CONVERSION_PCT = 0.01;

// Staff commission. 0 — the fee is paid by the customer, not the staff.
// Do not raise this above 0 without changing the whole business model.
export const PLATFORM_FEE_PCT = 0;

// Used only when the FX service can't produce a fresh rate.
export const DEFAULT_DOP_PER_USD = 59.25;

/** Round to 2 decimals (DOP cents). Avoids float drift. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute the breakdown for a tip.
 *
 * @param tipAmountDop    the tip — what staff receive (DOP). 100% of it.
 * @param fxRate          DOP per USD (from exchange-rate.service)
 * @param paymentMethod   'card' | 'apple_pay' | 'google_pay' | 'wallet' | 'dev'
 * @param chargedCurrency Stripe currency the PaymentIntent is in. Wallet tips
 *                        force 'dop' since no Stripe call happens at tip time.
 * @param customerFeeDop  fee charged to the customer on top of the tip (DOP).
 *                        Computed with `calculateCustomerFee` from
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
    throw new Error(`computeBreakdown: invalid tipAmount=${tipAmountDop}`);
  }
  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error(`computeBreakdown: invalid fxRate=${fxRate}`);
  }
  if (!Number.isFinite(customerFeeDop) || customerFeeDop < 0) {
    throw new Error(`computeBreakdown: invalid customerFee=${customerFeeDop}`);
  }

  const walletUsed = paymentMethod === "wallet";

  // What the customer is charged: tip + fee.
  const visibleAmount = round2(tipAmountDop + customerFeeDop);

  let stripeProcessingFee = 0;
  let stripeConversionFee = 0;

  if (!walletUsed) {
    // Informational: Stripe's cost is computed on the total charged, but it
    // is NOT deducted from the staff — TipApp absorbs it.
    const amountUsd = visibleAmount / fxRate;
    const processingUsd = amountUsd * STRIPE_PCT_USD + STRIPE_FIXED_USD;
    stripeProcessingFee = round2(processingUsd * fxRate);

    if (chargedCurrency === "usd") {
      const conversionUsd = amountUsd * STRIPE_CONVERSION_PCT;
      stripeConversionFee = round2(conversionUsd * fxRate);
    }
  }

  const totalProcessingCost = round2(stripeProcessingFee + stripeConversionFee);

  // Staff receive 100% of the tip. No exceptions.
  const staffNet = round2(tipAmountDop);

  return {
    tipAmount: round2(tipAmountDop),
    customerFee: round2(customerFeeDop),
    visibleAmount,
    stripeProcessingFee,
    stripeConversionFee,
    // Staff commission — always 0 under this model.
    platformFee: 0,
    marginSafety: 0,
    staffNet,
    totalProcessingCost,
    // TipApp's revenue on this transaction is the fee the customer paid.
    profitability: round2(customerFeeDop),
    exchangeRate: fxRate,
    currency: walletUsed ? "dop" : chargedCurrency,
    paymentMethod,
    walletUsed,
  };
}
