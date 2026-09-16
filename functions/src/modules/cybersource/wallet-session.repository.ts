import { db } from "../../config/firebase";
import type { WalletSession } from "./cybersource.types";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

const COLLECTION = "cybersourceSessions";
export const SESSION_TTL_MS = 15 * 60 * 1000;

export class WalletSessionError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "FORBIDDEN" | "USED" | "EXPIRED") {
    super(code);
  }
}

export const walletSessionRepo = {
  newRef() {
    return db.collection(COLLECTION).doc();
  },

  ref(sessionId: string) {
    return db.collection(COLLECTION).doc(sessionId);
  },

  async create(
    ref: FirebaseFirestore.DocumentReference,
    data: Omit<WalletSession, "status" | "paymentId" | "tipId" | "errorMessage" | "createdAt" | "expiresAt">
  ): Promise<void> {
    const session: WalletSession = {
      ...data,
      status: "created",
      paymentId: null,
      tipId: null,
      errorMessage: null,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + SESSION_TTL_MS),
    };
    await ref.set(session);
  },

  /**
   * Atomically moves a session from `created` to `charging`. This is what
   * makes charging idempotent: a second call with the same session fails.
   */
  async claimForCharge(sessionId: string, uid: string): Promise<WalletSession> {
    const ref = this.ref(sessionId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new WalletSessionError("NOT_FOUND");
      const session = snap.data() as WalletSession;
      if (session.uid !== uid) throw new WalletSessionError("FORBIDDEN");
      if (session.status !== "created") throw new WalletSessionError("USED");
      if (session.expiresAt.toMillis() < Date.now()) throw new WalletSessionError("EXPIRED");
      tx.update(ref, { status: "charging" });
      return session;
    });
  },

  async markFailed(sessionId: string, errorMessage: string, paymentId: string | null) {
    await this.ref(sessionId).update({ status: "failed", errorMessage, paymentId });
  },
};
