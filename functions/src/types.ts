import * as admin from "firebase-admin";

// ─────────────────────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────────────────────
export type UserRole = "dj" | "waiter" | "vallet" | "bartender" | "other";

export interface BankAccount {
  bankName: string;
  accountType: "ahorros" | "corriente";
  accountNumber: string;          // encrypted — never expose in frontend
  accountNumberLast4: string;
  holderName: string;
  holderCedula: string;
  holderPhone: string;
  verified: boolean;
  addedAt: admin.firestore.Timestamp;
  updatedAt: admin.firestore.Timestamp;
}

export interface User {
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  planId: string;
  pin: string | null;
  active: boolean;
  bankAccount: BankAccount | null;
  createdAt: admin.firestore.Timestamp;
}

// ─────────────────────────────────────────────────────────────
// PLANS
// ─────────────────────────────────────────────────────────────
export interface Plan {
  name: string;
  commissionPct: number;
  monthlyFee: number;
  maxTipsPerMonth: number;        // -1 = unlimited
  features: string[];
}

// ─────────────────────────────────────────────────────────────
// TIPS
// ─────────────────────────────────────────────────────────────
export type TipStatus = "pending" | "paid";
export type TipSource = "qr" | "manual";

// Per-transaction pricing ledger written by the pricing engine. Lets us
// audit profitability without re-running the math. Optional on `Tip` because
// tips created before the pricing engine rolled out won't have it; the
// `onTipCreated` trigger falls back to plan-based commissions in that case.
export type TipPricingPaymentMethod =
  | "card"
  | "apple_pay"
  | "google_pay"
  | "wallet"
  | "dev";

export type TipPricingCurrency = "dop" | "usd";

export interface TipPricingLedger {
  tipAmount?: number;              // DOP — la propina; lo que recibe el staff (100%)
  customerFee?: number;            // DOP — fee cobrado al cliente; ingreso de TipApp
  visibleAmount: number;           // DOP — what the customer pays: tipAmount + customerFee
  stripeProcessingFee: number;     // DOP — Stripe's 2.9% + $0.30 slice (informativo)
  stripeConversionFee: number;     // DOP — Stripe's 1% FX slice (0 if charged in DOP)
  platformFee: number;             // DOP — comisión al staff. Siempre 0.
  marginSafety: number;            // DOP — @deprecated, siempre 0
  staffNet: number;                // DOP — === tipAmount. El staff recibe el 100%.
  totalProcessingCost: number;     // DOP — stripeProcessingFee + stripeConversionFee
  profitability: number;           // DOP — customerFee
  exchangeRate: number;            // DOP per USD used in the calc
  currency: TipPricingCurrency;
  paymentMethod: TipPricingPaymentMethod;
  walletUsed: boolean;             // true when paid from wallet (no Stripe at tip time)
}

export interface Tip {
  userId: string;                  // staff (recipient) UID
  senderUid?: string;              // anonymous customer Firebase UID — drives /tippers counters
  amount: number;                  // la propina — lo que recibe el staff (100%). === tipAmount
  tipAmount?: number;              // alias explícito de `amount`; lo escribe el FE nuevo
  feeCharged?: number;             // DOP — fee cobrado al CLIENTE. Ingreso de TipApp.
  customerPaid?: number;           // DOP — amount + feeCharged. Lo que pagó el cliente.
  serviceFeeAmount?: number;       // legacy: fee paid by customer on top of tip (DOP) — direct-pay path
  totalChargedAmount?: number;     // legacy: tip + fee — what Stripe charged customer (DOP) — direct-pay path
  customerId?: string;             // legacy: hashed phone — present when paid from /balances (deprecated path)
  paidFromBalance?: boolean;       // legacy /balances path — kept for back-compat
  paidFromWallet?: boolean;        // true when debited from /tippers/{senderUid}.walletBalance
  commissionPct: number;           // siempre 0 — al staff no se le descuenta nada
  commissionAmt: number;           // siempre 0
  netAmount: number;               // === amount. El staff recibe el 100%.
  source: TipSource;
  status: TipStatus;
  payoutId: string | null;
  createdAt: admin.firestore.Timestamp;
  pricing?: TipPricingLedger;      // populated for tips created post-pricing-engine rollout
}

// ─────────────────────────────────────────────────────────────
// CUSTOMER BALANCES (top-up system)
// ─────────────────────────────────────────────────────────────
export interface Balance {
  phone: string;                              // normalized 10-digit DR phone
  email: string | null;
  balance: number;                            // current available balance (DOP)
  totalLoaded: number;                        // sum of all top-ups ever
  totalTipped: number;                        // sum of all balance-paid tips ever
  createdAt: admin.firestore.Timestamp;
  lastUsedAt: admin.firestore.Timestamp;
}

// Append-only ledger of every successful top-up.
//
// `tipappCost` is the loss-leader signal: visible == credit, so TipApp
// absorbs Stripe's processing + conversion fees on every top-up. Tracking
// it here lets analytics surface "how much are we burning to acquire wallet
// users" without joining against Stripe.
export interface Topup {
  customerId: string;
  grossAmount: number;                        // what the customer paid Stripe (DOP)
  stripeFee: number | null;                   // legacy: total fee field (kept for back-compat with v1 docs)
  stripeProcessingFee?: number;               // DOP — Stripe's 2.9% + $0.30 slice (estimated by pricing engine)
  stripeConversionFee?: number;               // DOP — Stripe's 1% FX slice (0 if charged in DOP)
  tipappCost?: number;                        // DOP — total fees absorbed by TipApp on this top-up
  exchangeRate?: number;                      // DOP per USD used at top-up time
  netAmount: number;                          // amount credited to balance (== gross: TipApp absorbs Stripe fee)
  createdAt: admin.firestore.Timestamp;
  stripePaymentIntentId: string;
}

// ─────────────────────────────────────────────────────────────
// TIPPERS — anonymous customers tracked by Firebase auth UID.
// Drives the wallet onboarding trigger and stores the wallet balance
// for the new "tip first, opt into wallet later" flow.
// ─────────────────────────────────────────────────────────────
export interface Tipper {
  totalTipsCount: number;                     // count of successful tips (any payment method)
  totalTipsAmount: number;                    // sum of tip amounts in DOP
  walletBalance: number;                      // current wallet balance in DOP
  totalLoaded: number;                        // sum of all wallet top-ups
  totalSpentFromWallet: number;               // sum of tips paid from wallet
  hasSeenWalletOnboarding: boolean;           // sticky once shown — prevents nagging
  createdAt: admin.firestore.Timestamp;
  updatedAt: admin.firestore.Timestamp;
  lastTipAt?: admin.firestore.Timestamp;
}

// Append-only event log for analytics. Drives "onboarding shown",
// "topup success", "wallet usage" downstream pipelines.
export type WalletEventType =
  | "onboarding_shown"
  | "onboarding_dismissed"
  | "topup_intent_created"
  | "topup_success"
  | "wallet_tip"
  | "wallet_insufficient"
  | "email_verify_started"
  | "email_verify_success"
  | "email_verify_failed";

export interface WalletEvent {
  uid: string;
  type: WalletEventType;
  amount?: number;
  staffId?: string;
  paymentIntentId?: string;
  createdAt: admin.firestore.Timestamp;
}

// ─────────────────────────────────────────────────────────────
// PAYOUTS
// ─────────────────────────────────────────────────────────────
export type PayoutStatus = "pending" | "paid" | "failed";
export type PaymentMethod = "transfer" | "cash";

export interface Payout {
  userId: string;
  tipsIncluded: string[];
  grossAmount: number;
  commissionAmt: number;
  netToUser: number;
  method: PaymentMethod;
  bankName: string;
  accountType: string;
  accountLast4: string;
  holderName: string;
  referenceNumber: string | null;
  receiptUrl: string | null;
  receiptUploadedAt: admin.firestore.Timestamp | null;
  transferDate: admin.firestore.Timestamp;
  notes: string | null;
  status: PayoutStatus;
  createdAt: admin.firestore.Timestamp;
}

// ─────────────────────────────────────────────────────────────
// COMMISSIONS
// ─────────────────────────────────────────────────────────────
export type CommissionStatus = "pending" | "settled";
export type CommissionSourceType = "tip" | "payout";

export interface Commission {
  userId: string;
  userName: string;
  userRole: UserRole;
  sourceId: string;
  sourceType: CommissionSourceType;
  grossAmount: number;
  commissionPct: number;
  commissionAmt: number;
  status: CommissionStatus;
  settledAt: admin.firestore.Timestamp | null;
  createdAt: admin.firestore.Timestamp;
}

// ─────────────────────────────────────────────────────────────
// DAILY SUMMARIES
// ─────────────────────────────────────────────────────────────
export interface DailySummary {
  date: string;                   // "2025-03-22"
  totalGross: number;
  totalCommissions: number;
  totalPaidOut: number;
  totalPending: number;
  tipCount: number;
  activeUsers: number;
  closed: boolean;
  closedAt?: admin.firestore.Timestamp;
  updatedAt: admin.firestore.Timestamp;
}

// ─────────────────────────────────────────────────────────────
// USER DAILY STATS
// ─────────────────────────────────────────────────────────────
export interface UserDailyStats {
  userId: string;
  userName: string;
  role: UserRole;
  date: string;
  totalGross: number;
  commissionAmt: number;
  netEarned: number;
  tipCount: number;
  pending: number;
  paidOut: number;
  updatedAt: admin.firestore.Timestamp;
}

// ─────────────────────────────────────────────────────────────
// SUBSCRIPTIONS
// ─────────────────────────────────────────────────────────────
export type SubscriptionStatus = "active" | "canceled" | "past_due";

export interface Subscription {
  userId: string;
  planId: string;
  status: SubscriptionStatus;
  startDate: admin.firestore.Timestamp;
  renewalDate: Date;
  canceledAt: admin.firestore.Timestamp | null;
}

// ─────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────
export type NotificationType = "new_tip" | "payout_completed" | "user_signup";

export interface Notification {
  type: NotificationType;
  message: string;
  userId: string;
  role?: UserRole;
  tipId?: string;
  payoutId?: string;
  amount?: number;
  commissionAmt?: number;
  read: boolean;
  createdAt: admin.firestore.Timestamp;
}
