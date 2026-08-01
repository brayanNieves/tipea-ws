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
  /** La propina — lo que recibe el staff. DOP. Siempre el 100%. */
  tipAmount: number;
  /** Fee cobrado al CLIENTE encima de la propina, DOP. Ingreso de TipApp. */
  customerFee: number;
  /** What the customer pays / sees: tipAmount + customerFee. DOP. */
  visibleAmount: number;
  /** Stripe's 2.9% + $0.30 processing slice, in DOP. 0 for wallet tips.
   *  Informativo — TipApp lo absorbe, no se le descuenta al staff. */
  stripeProcessingFee: number;
  /** Stripe's 1% currency conversion slice, in DOP. 0 if charged in DOP.
   *  Informativo — TipApp lo absorbe, no se le descuenta al staff. */
  stripeConversionFee: number;
  /** Comisión al staff. Siempre 0 — el fee lo paga el cliente. */
  platformFee: number;
  /** @deprecated Siempre 0. El buffer ya no se le descuenta al staff. */
  marginSafety: number;
  /** Lo que recibe el staff: SIEMPRE === tipAmount (100%). */
  staffNet: number;
  /** stripeProcessingFee + stripeConversionFee. Informativo. */
  totalProcessingCost: number;
  /** Ingreso de TipApp en esta transacción: customerFee. */
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
