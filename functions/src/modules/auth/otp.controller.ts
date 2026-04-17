import { onRequest } from "firebase-functions/v2/https";
import { admin, db } from "../../config/firebase";
import { mailer } from "../../mailer_service";
import { corsHandler } from "../../shared/utils/cors";
import {
  OTP_EXPIRES_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RATE_LIMIT_SECONDS,
} from "./otp.constants";

// ─────────────────────────────────────────────────────────────
// sendOtp
// Generates a 6-digit OTP and sends it to the provided email.
//
// Request:  { email: string }
// Response: { success: true }
//
// - OTP expires in 10 minutes
// - Rate-limited: 1 request per minute per email
// ─────────────────────────────────────────────────────────────
export const sendOtp = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { email } = req.body as { email?: string };

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: "A valid email address is required." });
      return;
    }

    const otpRef = db.doc(`otps/${email}`);
    const existing = await otpRef.get();

    if (existing.exists) {
      const createdAt = existing.data()?.createdAt?.toDate() as Date | undefined;
      if (createdAt) {
        const secondsElapsed = (Date.now() - createdAt.getTime()) / 1000;
        if (secondsElapsed < OTP_RATE_LIMIT_SECONDS) {
          const waitSeconds = Math.ceil(OTP_RATE_LIMIT_SECONDS - secondsElapsed);
          res
            .status(429)
            .json({ error: `Please wait ${waitSeconds}s before requesting a new code.` });
          return;
        }
      }
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + OTP_EXPIRES_MINUTES * 60 * 1000);

    await otpRef.set({
      code: otp,
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      attempts: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const sent = await mailer.sendOtpMail(email, otp, OTP_EXPIRES_MINUTES);
    if (!sent) {
      res.status(500).json({ error: "Failed to send OTP email. Please try again." });
      return;
    }

    console.log(`✅ [sendOtp] OTP sent → ${email}`);
    res.json({ success: true, message: "Verification code sent to your email." });
  });
});

// ─────────────────────────────────────────────────────────────
// verifyOtp
// Validates the 6-digit OTP for a given email.
//
// Request:  { email: string, code: string }
// Response: { success: true }
//
// - Returns error if expired, incorrect, or max attempts reached
// - Deletes the OTP document on success
// ─────────────────────────────────────────────────────────────
export const verifyOtp = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { email, code } = req.body as { email?: string; code?: string };

    if (!email || !code) {
      res.status(400).json({ error: "email and code are required." });
      return;
    }

    if (!/^\d{6}$/.test(code)) {
      res.status(400).json({ error: "OTP must be a 6-digit number." });
      return;
    }

    const otpRef = db.doc(`otps/${email}`);

    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(otpRef);

        if (!snap.exists) {
          throw Object.assign(
            new Error("No verification code found for this email. Please request a new one."),
            { status: 404 }
          );
        }

        const data = snap.data()!;
        const attempts: number = data.attempts ?? 0;
        const expiresAt = (data.expiresAt as admin.firestore.Timestamp).toDate();

        if (attempts >= OTP_MAX_ATTEMPTS) {
          tx.delete(otpRef);
          throw Object.assign(new Error("Too many failed attempts. Please request a new code."), {
            status: 429,
          });
        }

        if (new Date() > expiresAt) {
          tx.delete(otpRef);
          throw Object.assign(
            new Error("Verification code has expired. Please request a new one."),
            { status: 410 }
          );
        }

        if (data.code !== code) {
          tx.update(otpRef, { attempts: admin.firestore.FieldValue.increment(1) });
          const remaining = OTP_MAX_ATTEMPTS - attempts - 1;
          throw Object.assign(new Error(`Incorrect code. ${remaining} attempt(s) remaining.`), {
            status: 400,
          });
        }

        tx.delete(otpRef);
      });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status ?? 500;
      const message = err instanceof Error ? err.message : "Unexpected error";
      res.status(status).json({ error: message });
      return;
    }

    console.log(`✅ [verifyOtp] OTP verified → ${email}`);
    res.json({ success: true, message: "Email verified successfully." });
  });
});
