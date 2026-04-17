import type { TipCommissionResult } from "./tip.types";

/**
 * Calculates commission and net amount for a tip, given the plan's
 * commission percentage (0-100). Commission is rounded to whole units.
 */
export function calculateCommission(
  amount: number,
  commissionPct: number
): TipCommissionResult {
  const pct = commissionPct ?? 0;
  const commissionAmt = Math.round((amount * pct) / 100);
  const netAmount = amount - commissionAmt;
  return { commissionPct: pct, commissionAmt, netAmount };
}
