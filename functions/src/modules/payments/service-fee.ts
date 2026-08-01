// ─────────────────────────────────────────────────────────────
// Customer service fee
//
// The fee is charged to the CUSTOMER on top of the tip. Staff always
// receive 100% of `tipAmount` — nothing is ever deducted from them.
//
// Live values come from /config/customerFee (see customer-fee.repository).
// Mirrored in:
//   - client-tipapp/lib/fee.ts
//   - tipapp-backoffice/lib/service-fee.ts
// If you change the formula here, change it in all three.
// ─────────────────────────────────────────────────────────────

export interface CustomerFeeConfig {
  /** Percentage taken on the tip. e.g. 8 means 8%. */
  percentageFee: number;
  /** Flat amount per transaction, in RD$. e.g. 5. */
  fixedFee: number;
}

export interface CustomerFeeBreakdown {
  /** What staff receive — always 100%. */
  tipAmount: number;
  /** Percentage slice of the fee. e.g. RD$ 8 (8% of RD$ 100). */
  percentageAmount: number;
  /** Flat slice of the fee. e.g. RD$ 5. */
  fixedFee: number;
  /** Total fee charged to the customer. e.g. RD$ 13. */
  totalFee: number;
  /** Total charged to the customer. e.g. RD$ 113. */
  customerPays: number;
}

/** Used when /config/customerFee doesn't exist yet. */
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
    tipAmount, // what staff receive — always 100%
    percentageAmount, // e.g. RD$ 8 (8% of RD$ 100)
    fixedFee, // e.g. RD$ 5 flat
    totalFee, // e.g. RD$ 13 total fee
    customerPays, // e.g. RD$ 113 total charged to the customer
  };
}
