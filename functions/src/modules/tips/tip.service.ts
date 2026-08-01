import type { TipCommissionResult } from "./tip.types";

/**
 * El staff SIEMPRE recibe el 100% de la propina. El fee se le cobra al
 * cliente encima del monto (ver `payments/service-fee.ts` y
 * /config/customerFee), así que nunca hay deducción sobre el pago al staff.
 *
 * Se conserva la firma para no romper llamadores existentes; el parámetro
 * `commissionPct` se ignora deliberadamente.
 */
export function calculateCommission(
  amount: number,
  _commissionPct?: number
): TipCommissionResult {
  return { commissionPct: 0, commissionAmt: 0, netAmount: amount };
}
