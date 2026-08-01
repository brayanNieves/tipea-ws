// ─────────────────────────────────────────────────────────────
// Pricing service
//
// Thin wrapper around the pure engine that resolves the live FX rate from
// `exchange-rate.service.ts`. Controllers should depend on this service
// (not the engine directly) so callers don't have to thread the rate.
//
// `customerFeeDop` is the fee charged to the CUSTOMER on top of the tip. It
// comes from /config/customerFee via `customerFeeRepo` +
// `calculateCustomerFee`. Staff always receive 100% of the tip.
// ─────────────────────────────────────────────────────────────

import { getUsdToDopRate } from "../payments/exchange-rate.service";
import { computeBreakdown, DEFAULT_DOP_PER_USD } from "./pricing.engine";
import type {
  PricingBreakdown,
  PricingCurrency,
  PricingPaymentMethod,
} from "./pricing.types";

export const pricingService = {
  /**
   * Resolve the FX rate (cache → API → fallback) and compute the breakdown.
   */
  async breakdownFor(
    tipAmountDop: number,
    paymentMethod: PricingPaymentMethod,
    chargedCurrency: PricingCurrency = "usd",
    customerFeeDop: number = 0
  ): Promise<PricingBreakdown> {
    let fxRate = DEFAULT_DOP_PER_USD;
    try {
      const { rate } = await getUsdToDopRate();
      if (Number.isFinite(rate) && rate > 0) fxRate = rate;
    } catch {
      // exchange-rate.service already has its own fallbacks; if even those
      // throw, fall back to the engine default to avoid breaking the tip flow.
    }
    return computeBreakdown(tipAmountDop, fxRate, paymentMethod, chargedCurrency, customerFeeDop);
  },

  /** Sync variant — when the caller already has the FX rate in hand. */
  computeWithRate(
    tipAmountDop: number,
    fxRate: number,
    paymentMethod: PricingPaymentMethod,
    chargedCurrency: PricingCurrency = "usd",
    customerFeeDop: number = 0
  ): PricingBreakdown {
    return computeBreakdown(tipAmountDop, fxRate, paymentMethod, chargedCurrency, customerFeeDop);
  },
};
