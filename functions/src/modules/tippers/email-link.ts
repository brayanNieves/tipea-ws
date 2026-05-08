import { createHash } from "crypto";
import { admin, db } from "../../config/firebase";
import { normalizeEmail } from "../auth/otp.service";

/** Stable hash for using email as a Firestore doc id. */
export function emailHash(rawEmail: string): string {
  return createHash("sha256").update(normalizeEmail(rawEmail)).digest("hex").slice(0, 32);
}

const uidToCanonCol = () => db.collection("uid_to_canon_email");
const emailCanonCol = () => db.collection("email_canon_uid");

interface UidToCanon {
  email: string;
  canonUid: string;
  verifiedAt: admin.firestore.Timestamp;
}

interface EmailCanon {
  email: string;
  canonUid: string;
  firstVerifiedAt: admin.firestore.Timestamp;
}

/**
 * Called from `verifyWalletOtp` after an OTP is validated.
 *
 * Records that `currentUid` has proven control of `email`. If this is the
 * first time anyone verifies this email, `currentUid` becomes the canonical
 * owner of the wallet keyed by this email. Otherwise the existing canonical
 * uid is preserved (so balances persist across devices).
 *
 * Returns the canonUid — the uid whose `/tippers/{canonUid}` doc holds the
 * wallet for this email going forward.
 */
export async function recordEmailVerification(
  currentUid: string,
  rawEmail: string
): Promise<{ canonUid: string }> {
  const email = normalizeEmail(rawEmail);
  const hash = emailHash(email);
  const canonRef = emailCanonCol().doc(hash);
  const linkRef = uidToCanonCol().doc(currentUid);

  return db.runTransaction(async (tx) => {
    const canonSnap = await tx.get(canonRef);
    const now = admin.firestore.FieldValue.serverTimestamp();

    let canonUid: string;
    if (!canonSnap.exists) {
      canonUid = currentUid;
      tx.set(canonRef, {
        email,
        canonUid,
        firstVerifiedAt: now,
      } as Partial<EmailCanon>);
    } else {
      canonUid = (canonSnap.data() as EmailCanon).canonUid;
    }

    tx.set(linkRef, {
      email,
      canonUid,
      verifiedAt: now,
    } as Partial<UidToCanon>);

    return { canonUid };
  });
}

/**
 * Called from every wallet callable that takes `email`. Looks up
 * `/uid_to_canon_email/{currentUid}` and asserts that:
 *   1. The current uid has verified an email at all.
 *   2. The email it verified matches the email passed in the request.
 *
 * On success, returns the canonUid so the caller can target /tippers.
 * On failure, throws an Error whose message is suitable for HttpsError.
 */
export async function resolveCanonUid(
  currentUid: string,
  rawEmail: string
): Promise<string> {
  const email = normalizeEmail(rawEmail);
  const linkSnap = await uidToCanonCol().doc(currentUid).get();
  if (!linkSnap.exists) {
    throw new Error("EMAIL_NOT_VERIFIED");
  }
  const data = linkSnap.data() as UidToCanon;
  if (data.email !== email) {
    throw new Error("EMAIL_MISMATCH");
  }
  return data.canonUid;
}
