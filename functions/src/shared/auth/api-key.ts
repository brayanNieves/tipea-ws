import { timingSafeEqual } from "crypto";
import type { Request, Response } from "express";

const HEADER_NAME = "x-api-key";

/**
 * Constant-time string comparison.
 * Returns false on any length mismatch (to avoid length oracle).
 */
function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verifies the `x-api-key` header matches the expected key.
 * On failure, writes a 401/403 response and returns false — the caller
 * MUST return early when this returns false.
 *
 * Usage:
 *   if (!requireApiKey(req, res, myKey.value())) return;
 *
 * Responses:
 *   401 — header missing
 *   403 — header present but wrong
 *   500 — server has no configured key (misconfiguration)
 */
export function requireApiKey(
  req: Request,
  res: Response,
  expectedKey: string
): boolean {
  if (!expectedKey) {
    console.error("[requireApiKey] expected key is empty — secret not configured");
    res.status(500).json({ error: "Server auth misconfigured" });
    return false;
  }

  const raw = req.header(HEADER_NAME) ?? req.header(HEADER_NAME.toUpperCase()) ?? "";
  const provided = raw.trim();

  if (!provided) {
    res.status(401).json({ error: `Missing ${HEADER_NAME} header` });
    return false;
  }

  if (!safeEqual(provided, expectedKey)) {
    res.status(403).json({ error: "Invalid API key" });
    return false;
  }

  return true;
}
