import type { PricingBreakdown } from "../pricing/pricing.types";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

export type CybersourceWallet = "apple_pay" | "google_pay";

export type WalletSessionStatus = "created" | "charging" | "paid" | "failed";

/** /cybersourceSessions/{sessionId} — only touched by Cloud Functions. */
export interface WalletSession {
  uid: string;
  targetUserId: string;
  wallet: CybersourceWallet;
  tipAmount: number;
  feeCharged: number;
  customerPays: number;
  currency: "DOP";
  pricing: PricingBreakdown;
  status: WalletSessionStatus;
  paymentId: string | null;
  tipId: string | null;
  errorMessage: string | null;
  createdAt: FieldValue | Timestamp;
  expiresAt: Timestamp;
}

export interface CreateSessionRequest {
  amount?: number;
  targetUserId?: string;
  wallet?: CybersourceWallet;
}

export interface CreateSessionResponse {
  sessionId: string;
  captureContext: string;
  tipAmount: number;
  feeCharged: number;
  customerPays: number;
}

export interface ChargeTipRequest {
  sessionId?: string;
  transientToken?: string;
  songRequest?: unknown;
  rating?: number | null;
  comment?: string | null;
}

export interface ChargeTipResponse {
  tipId: string;
}

/** Subset of the /pts/v2/payments response we rely on. */
export interface CybersourcePaymentResult {
  id?: string;
  status?: string;
  errorInformation?: { reason?: string; message?: string };
  message?: string;
  reason?: string;
}
