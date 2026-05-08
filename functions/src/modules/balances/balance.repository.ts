import { admin, db } from "../../config/firebase";
import { Balance } from "../../types";

const balancesCol = () => db.collection("balances");
const topupsCol = () => db.collection("topups");

export interface BalanceSnapshot {
  customerId: string;
  balance: number;
  totalLoaded: number;
  totalTipped: number;
  exists: boolean;
}

export const balanceRepo = {
  /**
   * Read the current balance for a customer. Returns a zero-valued snapshot if
   * the doc doesn't exist (so callers can branch on `exists`).
   */
  async get(customerId: string): Promise<BalanceSnapshot> {
    const snap = await balancesCol().doc(customerId).get();
    if (!snap.exists) {
      return { customerId, balance: 0, totalLoaded: 0, totalTipped: 0, exists: false };
    }
    const data = snap.data() as Balance;
    return {
      customerId,
      balance: data.balance ?? 0,
      totalLoaded: data.totalLoaded ?? 0,
      totalTipped: data.totalTipped ?? 0,
      exists: true,
    };
  },

  /**
   * Atomically credit a balance from a top-up. Idempotent on `paymentIntentId`:
   * if a /topups doc already exists with the same PI ID, this is a no-op and
   * returns the current balance unchanged.
   *
   * Creates the /balances doc if it doesn't exist.
   */
  async credit(args: {
    customerId: string;
    phone: string;
    email: string | null;
    amount: number;
    paymentIntentId: string;
  }): Promise<{ balance: number; alreadyApplied: boolean }> {
    const { customerId, phone, email, amount, paymentIntentId } = args;
    const balanceRef = balancesCol().doc(customerId);

    return db.runTransaction(async (tx) => {
      // Idempotency check: has a topup doc with this PI ID already been recorded?
      const dupQ = await tx.get(
        topupsCol().where("stripePaymentIntentId", "==", paymentIntentId).limit(1)
      );
      if (!dupQ.empty) {
        const balSnap = await tx.get(balanceRef);
        const cur = balSnap.exists ? (balSnap.data() as Balance).balance : 0;
        return { balance: cur, alreadyApplied: true };
      }

      const balSnap = await tx.get(balanceRef);
      const now = admin.firestore.FieldValue.serverTimestamp();

      if (!balSnap.exists) {
        tx.set(balanceRef, {
          phone,
          email,
          balance: amount,
          totalLoaded: amount,
          totalTipped: 0,
          createdAt: now,
          lastUsedAt: now,
        });
      } else {
        tx.update(balanceRef, {
          balance: admin.firestore.FieldValue.increment(amount),
          totalLoaded: admin.firestore.FieldValue.increment(amount),
          lastUsedAt: now,
          // backfill phone/email if missing
          ...(balSnap.data()?.phone ? {} : { phone }),
          ...(email && !balSnap.data()?.email ? { email } : {}),
        });
      }

      const topupRef = topupsCol().doc();
      tx.set(topupRef, {
        customerId,
        grossAmount: amount,
        stripeFee: null,         // v1: no balance.transaction webhook
        netAmount: amount,        // TipApp absorbs Stripe fee — customer balance == gross
        createdAt: now,
        stripePaymentIntentId: paymentIntentId,
      });

      const newBalance = (balSnap.exists ? (balSnap.data() as Balance).balance : 0) + amount;
      return { balance: newBalance, alreadyApplied: false };
    });
  },

  /**
   * Atomically debit a balance for a tip. Throws if balance < amount.
   * Caller is responsible for creating the corresponding /tips doc inside the
   * same transaction by passing a `tipWriter` callback that receives the
   * transaction object.
   */
  async debitAndCreateTip(args: {
    customerId: string;
    amount: number;
    tipWriter: (tx: FirebaseFirestore.Transaction, tipRef: FirebaseFirestore.DocumentReference) => void;
  }): Promise<{ tipId: string; remainingBalance: number }> {
    const { customerId, amount, tipWriter } = args;
    const balanceRef = balancesCol().doc(customerId);
    const tipRef = db.collection("tips").doc();

    return db.runTransaction(async (tx) => {
      const balSnap = await tx.get(balanceRef);
      if (!balSnap.exists) {
        throw new Error("BALANCE_NOT_FOUND");
      }
      const data = balSnap.data() as Balance;
      const cur = data.balance ?? 0;
      if (cur < amount) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      tx.update(balanceRef, {
        balance: admin.firestore.FieldValue.increment(-amount),
        totalTipped: admin.firestore.FieldValue.increment(amount),
        lastUsedAt: now,
      });

      tipWriter(tx, tipRef);

      return { tipId: tipRef.id, remainingBalance: cur - amount };
    });
  },
};
