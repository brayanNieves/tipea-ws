// Service fee paid by the customer on top of the tip. Set to 0 — TipApp
// absorbs Stripe processing on direct tips and recovers cost on the wallet
// top-up path instead. Mirror in client-tipapp/lib/fee.ts.
export const SERVICE_FEE_PCT = 0;

export function calculateServiceFee(tipDop: number): number {
  return Math.round((tipDop * SERVICE_FEE_PCT) / 100);
}

export function calculateTotalCharge(tipDop: number): number {
  return tipDop + calculateServiceFee(tipDop);
}
