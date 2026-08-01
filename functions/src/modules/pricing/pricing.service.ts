// ─────────────────────────────────────────────────────────────
// Pricing service
//
// Wrapper delgado sobre el engine puro que resuelve el tipo de cambio vivo
// desde `exchange-rate.service.ts`. Los controllers deben depender de este
// servicio (no del engine directo) para no tener que pasar la tasa.
//
// `customerFeeDop` es el fee que se le cobra AL CLIENTE encima de la propina.
// Sale de /config/customerFee vía `customerFeeRepo` + `calculateCustomerFee`.
// El staff siempre recibe el 100% de la propina.
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
   * Resuelve el tipo de cambio (cache → API → fallback) y calcula el desglose.
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
      // exchange-rate.service ya tiene sus propios fallbacks; si hasta esos
      // fallan, usamos el default del engine para no romper el flujo de propina.
    }
    return computeBreakdown(tipAmountDop, fxRate, paymentMethod, chargedCurrency, customerFeeDop);
  },

  /** Variante sync — cuando el caller ya tiene el tipo de cambio en mano. */
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
