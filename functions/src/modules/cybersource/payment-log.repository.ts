import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../config/firebase";
import type { CybersourceWallet } from "./cybersource.types";

export type PaymentLogStep =
  | "capture_context"
  | "3ds_setup"
  | "3ds_enroll"
  | "3ds_results"
  | "charge";

export interface PaymentLogEntry {
  sessionId: string;
  step: PaymentLogStep;
  /** HTTP status from Cybersource, or null when the call never got an answer. */
  httpStatus: number | null;
  /** Gateway response, sanitized. Null when there's only an error message. */
  response: unknown;
  /** Thrown error (network failure, unexpected shape…). */
  error?: string | null;
  uid: string;
  targetUserId: string;
  wallet: CybersourceWallet;
  amount: number;
}

// Keys whose values are secrets or card data. Matched case-insensitively at
// any depth; the value is replaced, the key is kept so the shape is readable.
const REDACTED_KEYS = [
  "capturecontext",
  "transienttoken",
  "transienttokenjwt",
  "accesstoken",
  "pareq",
  "stepupurl",
  "devicedatacollectionurl",
  "cavv",
  "xid",
  "cryptogram",
  "number",
  "securitycode",
  "expirationmonth",
  "expirationyear",
  "jwt",
  "token",
];

const MAX_STRING = 500;
const MAX_BYTES = 20_000;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === "_links") continue;
      out[key] = REDACTED_KEYS.includes(key.toLowerCase())
        ? v == null || v === ""
          ? v
          : "[redacted]"
        : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

function capSize(value: unknown): unknown {
  const json = JSON.stringify(value ?? null);
  if (json.length <= MAX_BYTES) return value;
  return { truncated: true, preview: json.slice(0, MAX_BYTES) };
}

/**
 * One entry per Cybersource call, so the backoffice can show what the gateway
 * answered at each step of a payment. Fire-and-forget: a logging failure must
 * never break or slow down the payment.
 */
export function logGatewayCall(entry: PaymentLogEntry): void {
  const { response, ...rest } = entry;
  // JWT strings (capture context) are never stored, only their absence/presence.
  const safeResponse =
    typeof response === "string" && response.split(".").length === 3
      ? "[jwt]"
      : capSize(sanitize(response));

  db.collection("payment_logs")
    .add({
      ...rest,
      error: entry.error ?? null,
      response: safeResponse ?? null,
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch((e) => console.error("[payment-log] write failed", e));
}
