import type { firestore } from "firebase-admin";

export type TipStatus = "pending" | "paid" | "error";
export type TipSource = "qr" | "manual";

export interface Tip {
  userId: string;
  senderUid?: string;
  amount: number;
  commissionPct?: number;
  commissionAmt?: number;
  netAmount?: number;
  source?: TipSource;
  status: TipStatus;
  payoutId?: string | null;
  createdAt: firestore.Timestamp;
}

export interface TipCommissionResult {
  commissionPct: number;
  commissionAmt: number;
  netAmount: number;
}
