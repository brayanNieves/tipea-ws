import type { PricingBreakdown } from "../pricing/pricing.types";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

export type CybersourceWallet = "apple_pay" | "google_pay";

export type WalletSessionStatus = "created" | "authenticating" | "charging" | "paid" | "failed";

/** `data.type` inside the Unified Checkout transient token. */
export type TokenMethod = "APPLEPAY" | "GOOGLEPAY" | "PANENTRY" | "CLICKTOPAY" | "UNKNOWN";

/** Google Pay only: how the card is held. PAN_ONLY has no cryptogram → needs 3DS. */
export type GooglePayMode = "PAN_ONLY" | "CRYPTOGRAM_3DS";

/** Which authentication path a session took. */
export type ThreeDsMode = "none" | "frictionless" | "challenge";

/** Payer Authentication block echoed back into /pts/v2/payments. */
export interface ConsumerAuthentication {
  cavv?: string;
  eciRaw?: string;
  xid?: string;
  directoryServerTransactionId?: string;
  paSpecificationVersion?: string;
  authenticationTransactionId?: string;
  /** Cybersource commerce indicator, e.g. "vbv". */
  indicator?: string;
}

export interface TransientTokenInfo {
  method: TokenMethod;
  googlePayMode: GooglePayMode | null;
  /** Apple Pay, or Google Pay with a device cryptogram → no EMV 3DS. */
  skip3ds: boolean;
  billTo: Record<string, unknown> | null;
}

export type SessionDevice = "ios" | "android" | "mac" | "windows" | "other";

/** /cybersourceSessions/{sessionId} — only touched by Cloud Functions. */
export interface WalletSession {
  uid: string;
  targetUserId: string;
  wallet: CybersourceWallet;
  /** Device family the customer paid from (parsed from the User-Agent). */
  device?: SessionDevice;
  userAgent?: string | null;
  /** /companies doc id of the staff member's business, when set. */
  companyId?: string | null;
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
  // ── Payer Authentication (filled in by the 3DS callables) ──
  method?: TokenMethod;
  googlePayMode?: GooglePayMode | null;
  threeDs?: ThreeDsMode;
  referenceId?: string | null;
  authenticationTransactionId?: string | null;
  authentication?: ConsumerAuthentication | null;
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

export interface Setup3dsRequest {
  sessionId?: string;
  transientToken?: string;
}

export type Setup3dsResponse =
  | { mode: "wallet" }
  | {
      mode: "3ds";
      accessToken: string;
      deviceDataCollectionUrl: string;
      referenceId: string;
    };

export interface BrowserInfo {
  httpAcceptBrowserValue?: string;
  httpBrowserLanguage?: string;
  userAgentBrowserValue?: string;
}

export interface Enroll3dsRequest {
  sessionId?: string;
  transientToken?: string;
  returnUrl?: string;
  browser?: BrowserInfo;
}

export type Enroll3dsResponse =
  | { status: "ok" }
  | { status: "challenge"; stepUpUrl: string; accessToken: string; pareq: string };

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
  /** What the bank's settlement report is matched by, not the REST payment id. */
  reconciliationId?: string;
  processorInformation?: {
    approvalCode?: string;
    responseCode?: string;
    networkTransactionId?: string;
    transactionId?: string;
  };
  paymentInformation?: {
    /** The funding card. Wallets may send this, the tokenized one, or neither. */
    card?: { type?: string; suffix?: string; prefix?: string; bin?: string };
    /** The device token (DPAN) behind an Apple Pay / Google Pay payment. */
    tokenizedCard?: { type?: string; suffix?: string; prefix?: string };
  };
  errorInformation?: { reason?: string; message?: string };
  message?: string;
  reason?: string;
}

/**
 * The card as it is shown to a human. For a wallet, `last4` may belong to the
 * device token rather than to the plastic — that is what the processor returns
 * and what the bank's report shows.
 */
export interface PaymentCard {
  /** "Visa", "Mastercard"… or the raw Cybersource code when unknown. */
  brand: string | null;
  last4: string | null;
  /** First six digits, when the processor sends them. */
  bin: string | null;
  /** True when it came from the tokenized card, not the funding one. */
  tokenized: boolean;
}

/** Reconciliation data kept on the tip, for the bank's report and disputes. */
export interface PaymentProcessorTrace {
  reconciliationId: string | null;
  approvalCode: string | null;
  responseCode: string | null;
  networkTransactionId: string | null;
}

/** Subset of the /risk/v1/* responses we rely on. */
export interface PayerAuthResult {
  id?: string;
  status?: string;
  consumerAuthenticationInformation?: ConsumerAuthentication & {
    accessToken?: string;
    deviceDataCollectionUrl?: string;
    referenceId?: string;
    stepUpUrl?: string;
    pareq?: string;
  };
  errorInformation?: { reason?: string; message?: string; details?: ErrorDetail[] };
  message?: string;
  reason?: string;
  /** On INVALID_REQUEST: which fields Cybersource rejected. */
  details?: ErrorDetail[];
}

export interface ErrorDetail {
  field?: string;
  reason?: string;
}
