// ─────────────────────────────────────────────────────────────
// Pricing engine — pure functions
//
// All money math for tips/top-ups is centralized here so frontends can stay
// dumb (they only render `visibleAmount`) and so we have a single place to
// adjust fees without combing through controllers.
//
// Constants are derived from a 5-screenshot Stripe sample:
//   processing_fee_usd = amount_usd × 0.029 + 0.30
//   conversion_fee_usd = amount_usd × 0.01
// At ~59.25 DOP/USD this lands at `amount_dop × 0.039 + RD$ 18`, which
// matches every observed transaction within rounding.
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

// Default platform commission, used only when the caller doesn't pass an
// explicit rate. Per-staff rates still come from `plans/{planId}.commissionPct`
// (Starter 7% / Pro 4% / Business 2%) so the plan tier remains the source
// of truth for what the staff actually pays.
export const PLATFORM_FEE_PCT = 0.06;

// Tiny buffer that absorbs DOP/USD intraday drift between the time we
// quote a preset and the time Stripe actually settles the transaction.
export const MARGIN_SAFETY_PCT = 0.01;

// Used only when the FX service can't produce a fresh rate.
export const DEFAULT_DOP_PER_USD = 59.25;

/** Round to 2 decimals (DOP cents). Avoids float drift. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute the breakdown for a given visible DOP amount.
 *
 * @param visibleAmountDop  what the customer pays / sees (DOP)
 * @param fxRate            DOP per USD (from exchange-rate.service)
 * @param paymentMethod     'card' | 'apple_pay' | 'google_pay' | 'wallet' | 'dev'
 * @param chargedCurrency   Stripe currency the PaymentIntent is in. Defaults
 *                          to 'usd' (chargeInUsd=true is the production mode).
 *                          Wallet tips override to 'dop' since no Stripe call
 *                          happens at tip time.
 * @param platformFeePct    Platform commission as a fraction (e.g. 0.07 for
 *                          Starter, 0.04 Pro, 0.02 Business). Defaults to
 *                          `PLATFORM_FEE_PCT` when the caller can't resolve
 *                          the staff's plan.
 */
export function computeBreakdown(
  visibleAmountDop: number,
  fxRate: number,
  paymentMethod: PricingPaymentMethod,
  chargedCurrency: PricingCurrency = "usd",
  platformFeePct: number = PLATFORM_FEE_PCT
): PricingBreakdown {
  if (!Number.isFinite(visibleAmountDop) || visibleAmountDop <= 0) {
    throw new Error(`computeBreakdown: invalid visibleAmount=${visibleAmountDop}`);
  }
  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error(`computeBreakdown: invalid fxRate=${fxRate}`);
  }
  if (!Number.isFinite(platformFeePct) || platformFeePct < 0 || platformFeePct > 1) {
    throw new Error(`computeBreakdown: invalid platformFeePct=${platformFeePct}`);
  }

  const walletUsed = paymentMethod === "wallet";

  let stripeProcessingFee = 0;
  let stripeConversionFee = 0;

  if (!walletUsed) {
    // Convert DOP → USD to compute Stripe's cut, then convert the cut back
    // to DOP so every column in the ledger speaks the same currency.
    const amountUsd = visibleAmountDop / fxRate;
    const processingUsd = amountUsd * STRIPE_PCT_USD + STRIPE_FIXED_USD;
    stripeProcessingFee = round2(processingUsd * fxRate);

    if (chargedCurrency === "usd") {
      const conversionUsd = amountUsd * STRIPE_CONVERSION_PCT;
      stripeConversionFee = round2(conversionUsd * fxRate);
    }
  }

  const platformFee = round2(visibleAmountDop * platformFeePct);
  const marginSafety = round2(visibleAmountDop * MARGIN_SAFETY_PCT);
  const totalProcessingCost = round2(stripeProcessingFee + stripeConversionFee);
  const staffNet = round2(
    visibleAmountDop - totalProcessingCost - platformFee - marginSafety
  );

  // For card/Apple Pay/Google Pay: TipApp's revenue is platformFee + margin.
  // Stripe is paid from the customer's gross before the staff sees it, so the
  // platform doesn't "absorb" Stripe on the direct path — the staff does
  // (their net is reduced by it).
  //
  // For wallet tips: there's no Stripe charge at tip time (it was paid at
  // top-up time and absorbed there), so platform revenue is simply platformFee
  // + margin and Stripe cost on this row is 0.
  //
  // Either way: profitability of THIS transaction = platformFee + marginSafety.
  const profitability = round2(platformFee + marginSafety);

  return {
    visibleAmount: round2(visibleAmountDop),
    stripeProcessingFee,
    stripeConversionFee,
    platformFee,
    marginSafety,
    staffNet,
    totalProcessingCost,
    profitability,
    exchangeRate: fxRate,
    currency: walletUsed ? "dop" : chargedCurrency,
    paymentMethod,
    walletUsed,
  };
}
