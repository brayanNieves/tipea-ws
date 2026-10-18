import { db } from "../../config/firebase";

const RATE_CACHE_DOC = "appConfig/exchangeRate";

export interface CachedRate {
  rate: number;
  fetchedAt: number;
}

export const exchangeRateRepo = {
  async read(): Promise<CachedRate | null> {
    const snap = await db.doc(RATE_CACHE_DOC).get();
    return snap.exists ? (snap.data() as CachedRate) : null;
  },

  async write(rate: number): Promise<void> {
    await db.doc(RATE_CACHE_DOC).set({ rate, fetchedAt: Date.now() }, { merge: true });
  },
};
