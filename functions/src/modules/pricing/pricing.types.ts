// ─────────────────────────────────────────────────────────────
// Pricing types
//
// `PricingBreakdown` is the canonical shape returned by the pricing engine
// for any tip or top-up. It captures every component that flows from the
// customer's visible amount to the staff's net payout — Stripe's processing
// + conversion fees, the platform's commission, the FX margin buffer, and
// the residual that lands in the staff's payout queue.
//
// The same shape is persisted to Firestore (as `Tip.pricing`) so we can
// reconcile profitability per transaction without re-running the math.
// ─────────────────────────────────────────────────────────────

export type PricingPaymentMethod =
  | "card"
  | "apple_pay"
  | "google_pay"
  | "wallet"
  | "dev";

export type PricingCurrency = "dop" | "usd";

export interface PricingBreakdown {
  /** What the customer pays / sees. DOP. */
  visibleAmount: number;
  /** Stripe's 2.9% + $0.30 processing slice, in DOP. 0 for wallet tips. */
  stripeProcessingFee: number;
  /** Stripe's 1% currency conversion slice, in DOP. 0 if charged in DOP. */
  stripeConversionFee: number;
  /** Platform commission (PLATFORM_FEE_PCT × visibleAmount), DOP. */
  platformFee: number;
  /** FX volatility buffer (MARGIN_SAFETY_PCT × visibleAmount), DOP. */
  marginSafety: number;
  /** What lands in the staff payout: visible − stripe − platformFee − margin. */
  staffNet: number;
  /** stripeProcessingFee + stripeConversionFee. */
  totalProcessingCost: number;
  /** platformFee + marginSafety − costsAbsorbedByPlatform. */
  profitability: number;
  /** DOP per USD used in the computation. */
  exchangeRate: number;
  /** Currency Stripe actually charged. */
  currency: PricingCurrency;
  /** Channel this breakdown was computed for. */
  paymentMethod: PricingPaymentMethod;
  /** True when paid from the customer's wallet (no Stripe touch on this tx). */
  walletUsed: boolean;
}
