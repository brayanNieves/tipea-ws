import { db } from "../../config/firebase";
import type { User } from "./user.types";

export const userRepo = {
  async exists(uid: string): Promise<boolean> {
    const snap = await db.doc(`users/${uid}`).get();
    return snap.exists;
  },

  async get(uid: string): Promise<User | null> {
    const snap = await db.doc(`users/${uid}`).get();
    return snap.exists ? (snap.data() as User) : null;
  },

  async getOrThrow(uid: string): Promise<User> {
    const user = await this.get(uid);
    if (!user) throw new Error(`User not found: ${uid}`);
    return user;
  },
};
