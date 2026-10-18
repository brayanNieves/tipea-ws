import { db } from "../../config/firebase";

/**
 * Returns true if the user document `users/{uid}` has `role === "admin"`.
 * Fails closed: missing doc, missing field, or read errors → false.
 */
export async function isAdmin(uid: string): Promise<boolean> {
  try {
    const snap = await db.doc(`users/${uid}`).get();
    if (!snap.exists) return false;
    const data = snap.data() as { role?: string } | undefined;
    return data?.role === "admin";
  } catch (e) {
    console.warn("[isAdmin] read failed", e);
    return false;
  }
}
