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
  /** The tip — what staff receive. DOP. Always 100% of it. */
  tipAmount: number;
  /** Fee charged to the CUSTOMER on top of the tip, DOP. TipApp's revenue. */
  customerFee: number;
  /** What the customer pays / sees: tipAmount + customerFee. DOP. */
  visibleAmount: number;
  /** Stripe's 2.9% + $0.30 processing slice, in DOP. 0 for wallet tips.
   *  Informational — TipApp absorbs it; never deducted from staff. */
  stripeProcessingFee: number;
  /** Stripe's 1% currency conversion slice, in DOP. 0 if charged in DOP.
   *  Informational — TipApp absorbs it; never deducted from staff. */
  stripeConversionFee: number;
  /** Staff commission. Always 0 — the customer pays the fee. */
  platformFee: number;
  /** @deprecated Always 0. The buffer is no longer deducted from staff. */
  marginSafety: number;
  /** What staff receive: ALWAYS === tipAmount (100%). */
  staffNet: number;
  /** stripeProcessingFee + stripeConversionFee. Informational. */
  totalProcessingCost: number;
  /** TipApp's revenue on this transaction: customerFee. */
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
