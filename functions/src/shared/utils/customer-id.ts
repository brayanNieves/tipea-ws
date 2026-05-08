import { createHash } from "crypto";

/**
 * Strip non-digits and DR country code prefix.
 * "+1 (809) 555-1234" → "8095551234"
 * "18095551234"      → "8095551234"
 * "8095551234"       → "8095551234"
 */
export function normalizePhone(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/**
 * Stable customer ID derived from the normalized phone. Used as the doc ID in
 * /balances/{customerId}. Plain SHA-256 (no salt) since v1 has no OTP — the hash
 * is just for stable IDs, not privacy. 32 hex chars = 128 bits of namespace.
 */
export function customerIdFromPhone(phone: string): string {
  return createHash("sha256").update(normalizePhone(phone)).digest("hex").slice(0, 32);
}

/**
 * Dominican Republic phone validation. After normalization the number must be
 * exactly 10 digits. DR mobile/landline area codes start with 8 (809, 829, 849).
 */
export function isValidDoPhone(normalized: string): boolean {
  return /^8\d{9}$/.test(normalized);
}
