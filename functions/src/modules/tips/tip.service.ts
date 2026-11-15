import type { TipCommissionResult } from "./tip.types";

/**
 * Staff ALWAYS receive 100% of the tip. The fee is charged to the customer
 * on top of it (see `payments/service-fee.ts` and /config/customerFee), so
 * there is never a deduction on the staff payout.
 *
 * The signature is kept so existing callers don't break; the `commissionPct`
 * parameter is deliberately ignored.
 */
export function calculateCommission(
  amount: number,
  _commissionPct?: number
): TipCommissionResult {
  return { commissionPct: 0, commissionAmt: 0, netAmount: amount };
}
