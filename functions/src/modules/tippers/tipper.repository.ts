import { admin, db } from "../../config/firebase";
import { Tipper, WalletEventType } from "../../types";

const tippersCol = () => db.collection("tippers");
const topupsCol = () => db.collection("topups");
const eventsCol = () => db.collection("wallet_events");

export interface TipperSnapshot {
  uid: string;
  totalTipsCount: number;
  totalTipsAmount: number;
  walletBalance: number;
  totalLoaded: number;
  totalSpentFromWallet: number;
  hasSeenWalletOnboarding: boolean;
  exists: boolean;
}

const ZERO = (uid: string): TipperSnapshot => ({
  uid,
  totalTipsCount: 0,
  totalTipsAmount: 0,
  walletBalance: 0,
  totalLoaded: 0,
  totalSpentFromWallet: 0,
  hasSeenWalletOnboarding: false,
  exists: false,
});

function toSnapshot(uid: string, data: Tipper): TipperSnapshot {
  return {
    uid,
    totalTipsCount: data.totalTipsCount ?? 0,
    totalTipsAmount: data.totalTipsAmount ?? 0,
    walletBalance: data.walletBalance ?? 0,
    totalLoaded: data.totalLoaded ?? 0,
    totalSpentFromWallet: data.totalSpentFromWallet ?? 0,
    hasSeenWalletOnboarding: data.hasSeenWalletOnboarding ?? false,
    exists: true,
  };
}

export const tipperRepo = {
  /** Read tipper for uid. Returns a zero-snapshot when the doc doesn't exist. */
  async get(uid: string): Promise<TipperSnapshot> {
    const snap = await tippersCol().doc(uid).get();
    if (!snap.exists) return ZERO(uid);
    return toSnapshot(uid, snap.data() as Tipper);
  },

  /** Idempotent — only sets the flag if not already set. */
  async markOnboardingSeen(uid: string): Promise<void> {
    const ref = tippersCol().doc(uid);
    const now = admin.firestore.FieldValue.serverTimestamp();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        tx.set(ref, {
          totalTipsCount: 0,
          totalTipsAmount: 0,
          walletBalance: 0,
          totalLoaded: 0,
          totalSpentFromWallet: 0,
          hasSeenWalletOnboarding: true,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        const data = snap.data() as Tipper;
        if (data.hasSeenWalletOnboarding === true) return;
        tx.update(ref, { hasSeenWalletOnboarding: true, updatedAt: now });
      }
    });
  },

  /**
   * Atomically credit walletBalance from a Stripe top-up. Idempotent on
   * `paymentIntentId` via the /topups dedup query.
   */
  async credit(args: {
    uid: string;
    amount: number;
    paymentIntentId: string;
  }): Promise<{ balance: number; alreadyApplied: boolean }> {
    const { uid, amount, paymentIntentId } = args;
    const ref = tippersCol().doc(uid);

    return db.runTransaction(async (tx) => {
      const dupQ = await tx.get(
        topupsCol().where("stripePaymentIntentId", "==", paymentIntentId).limit(1)
      );
      if (!dupQ.empty) {
        const cur = await tx.get(ref);
        const balance = cur.exists ? (cur.data() as Tipper).walletBalance ?? 0 : 0;
        return { balance, alreadyApplied: true };
      }

      const snap = await tx.get(ref);
      const now = admin.firestore.FieldValue.serverTimestamp();

      if (!snap.exists) {
        tx.set(ref, {
          totalTipsCount: 0,
          totalTipsAmount: 0,
          walletBalance: amount,
          totalLoaded: amount,
          totalSpentFromWallet: 0,
          hasSeenWalletOnboarding: true, // crediting implies onboarding completed
          createdAt: now,
          updatedAt: now,
        });
      } else {
        tx.update(ref, {
          walletBalance: admin.firestore.FieldValue.increment(amount),
          totalLoaded: admin.firestore.FieldValue.increment(amount),
          hasSeenWalletOnboarding: true,
          updatedAt: now,
        });
      }

      const topupRef = topupsCol().doc();
      tx.set(topupRef, {
        customerId: uid,                 // re-uses existing /topups schema; uid acts as customer
        grossAmount: amount,
        stripeFee: null,
        netAmount: amount,
        createdAt: now,
        stripePaymentIntentId: paymentIntentId,
      });

      const newBalance = (snap.exists ? (snap.data() as Tipper).walletBalance ?? 0 : 0) + amount;
      return { balance: newBalance, alreadyApplied: false };
    });
  },

  /**
   * Atomically debit walletBalance for a tip. Throws on insufficient balance.
   * The caller writes the /tips doc inside the same transaction via the
   * `tipWriter` callback so debit + tip-create are guaranteed consistent.
   */
  async debitAndCreateTip(args: {
    uid: string;
    amount: number;
    tipWriter: (tx: FirebaseFirestore.Transaction, tipRef: FirebaseFirestore.DocumentReference) => void;
  }): Promise<{ tipId: string; remainingBalance: number }> {
    const { uid, amount, tipWriter } = args;
    const ref = tippersCol().doc(uid);
    const tipRef = db.collection("tips").doc();

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("WALLET_NOT_FOUND");
      const data = snap.data() as Tipper;
      const cur = data.walletBalance ?? 0;
      if (cur < amount) throw new Error("INSUFFICIENT_WALLET");

      const now = admin.firestore.FieldValue.serverTimestamp();
      tx.update(ref, {
        walletBalance: admin.firestore.FieldValue.increment(-amount),
        totalSpentFromWallet: admin.firestore.FieldValue.increment(amount),
        // counter increments handled by onTipCreated trigger
        updatedAt: now,
      });

      tipWriter(tx, tipRef);

      return { tipId: tipRef.id, remainingBalance: cur - amount };
    });
  },

  /**
   * Called from the onTipCreated trigger to bump tip counters whenever a tip
   * carries a senderUid. Upserts the tipper doc.
   */
  async recordTip(uid: string, amount: number): Promise<void> {
    const ref = tippersCol().doc(uid);
    const now = admin.firestore.FieldValue.serverTimestamp();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        tx.set(ref, {
          totalTipsCount: 1,
          totalTipsAmount: amount,
          walletBalance: 0,
          totalLoaded: 0,
          totalSpentFromWallet: 0,
          hasSeenWalletOnboarding: false,
          createdAt: now,
          updatedAt: now,
          lastTipAt: now,
        });
      } else {
        tx.update(ref, {
          totalTipsCount: admin.firestore.FieldValue.increment(1),
          totalTipsAmount: admin.firestore.FieldValue.increment(amount),
          updatedAt: now,
          lastTipAt: now,
        });
      }
    });
  },

  /** Append a wallet event to /wallet_events for analytics. Fire-and-forget. */
  async logEvent(args: {
    uid: string;
    type: WalletEventType;
    amount?: number;
    staffId?: string;
    paymentIntentId?: string;
  }): Promise<void> {
    const { uid, type, amount, staffId, paymentIntentId } = args;
    await eventsCol().add({
      uid,
      type,
      ...(amount !== undefined ? { amount } : {}),
      ...(staffId ? { staffId } : {}),
      ...(paymentIntentId ? { paymentIntentId } : {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  },
};
