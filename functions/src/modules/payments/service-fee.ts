// ─────────────────────────────────────────────────────────────
// Fee al cliente
//
// El fee se cobra AL CLIENTE, encima del monto de la propina. El staff
// siempre recibe el 100% de `tipAmount` — nunca se le descuenta nada.
//
// Los valores vivos salen de /config/customerFee (ver customer-fee.repository).
// Espejo en:
//   - client-tipapp/lib/fee.ts
//   - tipapp-backoffice/lib/service-fee.ts
// Si cambias la fórmula acá, cámbiala en los tres.
// ─────────────────────────────────────────────────────────────

export interface CustomerFeeConfig {
  /** Porcentaje sobre la propina. Ej: 8 significa 8%. */
  percentageFee: number;
  /** Monto fijo por transacción, en RD$. Ej: 5. */
  fixedFee: number;
}

export interface CustomerFeeBreakdown {
  /** Lo que recibe el staff — siempre el 100%. */
  tipAmount: number;
  /** Porción porcentual del fee. Ej: RD$ 8 (8% de RD$ 100). */
  percentageAmount: number;
  /** Porción fija del fee. Ej: RD$ 5. */
  fixedFee: number;
  /** Fee total cobrado al cliente. Ej: RD$ 13. */
  totalFee: number;
  /** Total cobrado al cliente. Ej: RD$ 113. */
  customerPays: number;
}

/** Usado cuando /config/customerFee no existe todavía. */
export const DEFAULT_CUSTOMER_FEE: CustomerFeeConfig = {
  percentageFee: 8,
  fixedFee: 5,
};

export function calculateCustomerFee(
  tipAmount: number,
  percentageFee: number,
  fixedFee: number
): CustomerFeeBreakdown {
  const percentageAmount = Math.round(tipAmount * (percentageFee / 100));
  const totalFee = percentageAmount + fixedFee;
  const customerPays = tipAmount + totalFee;

  return {
    tipAmount, // lo que recibe el staff — siempre 100%
    percentageAmount, // ej: RD$ 8 (8% de RD$ 100)
    fixedFee, // ej: RD$ 5 fijo
    totalFee, // ej: RD$ 13 total del fee
    customerPays, // ej: RD$ 113 total cobrado al cliente
  };
}
