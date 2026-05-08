import { admin, db } from "../../config/firebase";
import { mailer } from "../../mailer_service";
import {
  OTP_EXPIRES_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RATE_LIMIT_SECONDS,
} from "./otp.constants";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalize email for hashing / lookup. Lowercase + trim.
 * Doesn't apply gmail dot-stripping or aliases — too aggressive for our use.
 */
export function normalizeEmail(raw: string): string {
  return (raw || "").trim().toLowerCase();
}

export function isValidEmail(raw: string): boolean {
  return EMAIL_RE.test(normalizeEmail(raw));
}

/**
 * Request a 6-digit OTP for the given email. The OTP is stored at
 * /otps/{normalizedEmail} with a 10-minute expiry. Rate-limited to one
 * request per minute per email.
 *
 * Reusable from any callable / endpoint that needs to verify an email
 * (sign-up, wallet recharge, etc.).
 */
export async function requestOtp(rawEmail: string): Promise<
  | { ok: true }
  | { ok: false; status: number; message: string }
> {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    return { ok: false, status: 400, message: "A valid email address is required." };
  }

  const otpRef = db.doc(`otps/${email}`);
  const existing = await otpRef.get();

  if (existing.exists) {
    const createdAt = (existing.data()?.createdAt as admin.firestore.Timestamp | undefined)?.toDate();
    if (createdAt) {
      const secondsElapsed = (Date.now() - createdAt.getTime()) / 1000;
      if (secondsElapsed < OTP_RATE_LIMIT_SECONDS) {
        const wait = Math.ceil(OTP_RATE_LIMIT_SECONDS - secondsElapsed);
        return { ok: false, status: 429, message: `Please wait ${wait}s before requesting a new code.` };
      }
    }
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + OTP_EXPIRES_MINUTES * 60 * 1000);

  await otpRef.set({
    code,
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    attempts: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const sent = await mailer.sendOtpMail(email, code, OTP_EXPIRES_MINUTES);
  if (!sent) {
    return { ok: false, status: 500, message: "Failed to send code. Please try again." };
  }

  console.log(`✅ [otp.requestOtp] code sent → ${email}`);
  return { ok: true };
}

/**
 * Validate the 6-digit code for an email. On success the OTP is deleted
 * (one-shot). On failure the attempts counter is incremented; after
 * OTP_MAX_ATTEMPTS the OTP is invalidated.
 */
export async function checkOtp(
  rawEmail: string,
  code: string
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    return { ok: false, status: 400, message: "A valid email address is required." };
  }
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, status: 400, message: "Code must be 6 digits." };
  }

  const otpRef = db.doc(`otps/${email}`);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(otpRef);
      if (!snap.exists) {
        throw Object.assign(new Error("No verification code on file. Request a new one."), { status: 404 });
      }

      const data = snap.data()!;
      const attempts: number = data.attempts ?? 0;
      const expiresAt = (data.expiresAt as admin.firestore.Timestamp).toDate();

      if (attempts >= OTP_MAX_ATTEMPTS) {
        tx.delete(otpRef);
        throw Object.assign(new Error("Too many failed attempts. Request a new code."), { status: 429 });
      }

      if (new Date() > expiresAt) {
        tx.delete(otpRef);
        throw Object.assign(new Error("Code expired. Request a new one."), { status: 410 });
      }

      if (data.code !== code) {
        tx.update(otpRef, { attempts: admin.firestore.FieldValue.increment(1) });
        const remaining = OTP_MAX_ATTEMPTS - attempts - 1;
        throw Object.assign(new Error(`Incorrect code. ${remaining} attempt(s) remaining.`), { status: 400 });
      }

      tx.delete(otpRef);
    });
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 500;
    const message = err instanceof Error ? err.message : "Unexpected error";
    return { ok: false, status, message };
  }

  console.log(`✅ [otp.checkOtp] verified → ${email}`);
  return { ok: true };
}
