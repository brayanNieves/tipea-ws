import type { firestore } from "firebase-admin";

export type UserRole = "dj" | "waiter" | "vallet" | "bartender" | "other";

export interface User {
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  planId: string;
  emailVerified?: boolean;
  createdAt: firestore.Timestamp;
}
