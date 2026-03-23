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

export interface Tip {
  userId: string;
  amount: number;
  commissionPct: number;
  commissionAmt: number;
  netAmount: number;
  source: TipSource;
  status: TipStatus;
  payoutId: string | null;
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
