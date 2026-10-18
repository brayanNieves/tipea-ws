import type { firestore } from "firebase-admin";

export type UserRole = "dj" | "waiter" | "vallet" | "bartender" | "admin" | "other";

export interface User {
  /**
   * Firebase Auth UID. Mirrors the Firestore document id (`users/{uid}`)
   * so client code can keep the value alongside other fields without
   * re-deriving it from the document path.
   */
  uid: string;
  name?: string;
  email?: string;
  phone?: string;
  role?: UserRole;
  planId: string;
  emailVerified?: boolean;
  active?: boolean;
  createdAt: firestore.Timestamp;
}
