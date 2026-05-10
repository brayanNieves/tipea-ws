// ─────────────────────────────────────────────────────────────
// Pricing service
//
// Thin wrapper around the pure engine that resolves the live FX rate from
// `exchange-rate.service.ts`. Controllers should depend on this service
// (not the engine directly) so callers don't have to thread the rate.
//
// `platformFeePct` is the staff's per-tip commission rate (Starter 7%,
// Pro 4%, Business 2%). Pass it whenever the caller can resolve the
// staff's plan; the engine falls back to the global default otherwise.
// ─────────────────────────────────────────────────────────────

import { getUsdToDopRate } from "../payments/exchange-rate.service";
import { computeBreakdown, DEFAULT_DOP_PER_USD, PLATFORM_FEE_PCT } from "./pricing.engine";
import type {
  PricingBreakdown,
  PricingCurrency,
  PricingPaymentMethod,
} from "./pricing.types";

export const pricingService = {
  /**
   * Resolve the FX rate (cache → API → fallback) and compute the breakdown.
   * Use this from any callable that needs the per-transaction ledger.
   */
  async breakdownFor(
    visibleAmountDop: number,
    paymentMethod: PricingPaymentMethod,
    chargedCurrency: PricingCurrency = "usd",
    platformFeePct: number = PLATFORM_FEE_PCT
  ): Promise<PricingBreakdown> {
    let fxRate = DEFAULT_DOP_PER_USD;
    try {
      const { rate } = await getUsdToDopRate();
      if (Number.isFinite(rate) && rate > 0) fxRate = rate;
    } catch {
      // exchange-rate.service already has its own fallbacks; if even those
      // throw, fall back to the engine default to avoid breaking the tip flow.
    }
    return computeBreakdown(visibleAmountDop, fxRate, paymentMethod, chargedCurrency, platformFeePct);
  },

  /** Sync variant — when the caller already has the FX rate in hand. */
  computeWithRate(
    visibleAmountDop: number,
    fxRate: number,
    paymentMethod: PricingPaymentMethod,
    chargedCurrency: PricingCurrency = "usd",
    platformFeePct: number = PLATFORM_FEE_PCT
  ): PricingBreakdown {
    return computeBreakdown(visibleAmountDop, fxRate, paymentMethod, chargedCurrency, platformFeePct);
  },
};

/**
 * Convert a plan's commissionPct (0–100, e.g. `7` for Starter) to the
 * 0–1 fraction the engine expects. Tolerates missing/invalid values by
 * falling back to the default.
 */
export function planCommissionFraction(commissionPct: number | null | undefined): number {
  if (!Number.isFinite(commissionPct) || commissionPct === null || commissionPct === undefined) {
    return PLATFORM_FEE_PCT;
  }
  const pct = commissionPct as number;
  if (pct < 0 || pct > 100) return PLATFORM_FEE_PCT;
  return pct / 100;
}
