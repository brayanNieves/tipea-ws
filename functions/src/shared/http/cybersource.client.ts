import * as crypto from "crypto";
import type { CybersourceCredentials } from "../../config/cybersource";

// ─────────────────────────────────────────────────────────────
// Cybersource REST client — HTTP Signature auth (HmacSHA256).
// https://developer.cybersource.com/docs/cybs/en-us/platform/developer/all/rest/rest-getting-started/restgs-http-message-intro.html
// ─────────────────────────────────────────────────────────────

export interface CybersourceResponse<T> {
  status: number;
  data: T;
}

function digestOf(body: string): string {
  return `SHA-256=${crypto.createHash("sha256").update(body, "utf8").digest("base64")}`;
}

function signedHeaders(
  creds: CybersourceCredentials,
  resource: string,
  body: string
): Record<string, string> {
  const date = new Date().toUTCString();
  const digest = digestOf(body);

  const signatureString = [
    `host: ${creds.host}`,
    `date: ${date}`,
    `(request-target): post ${resource}`,
    `digest: ${digest}`,
    `v-c-merchant-id: ${creds.merchantId}`,
  ].join("\n");

  const signature = crypto
    .createHmac("sha256", creds.secretKey)
    .update(signatureString, "utf8")
    .digest("base64");

  return {
    "v-c-merchant-id": creds.merchantId,
    date,
    host: creds.host,
    digest,
    signature:
      `keyid="${creds.apiKeyId}", algorithm="HmacSHA256", ` +
      `headers="host date (request-target) digest v-c-merchant-id", signature="${signature}"`,
    "Content-Type": "application/json;charset=utf-8",
  };
}

/** POSTs a signed JSON payload. Never throws on non-2xx — callers check `status`. */
export async function cybersourcePost<T>(
  creds: CybersourceCredentials,
  resource: string,
  payload: unknown
): Promise<CybersourceResponse<T>> {
  const body = JSON.stringify(payload);
  const res = await fetch(`https://${creds.host}${resource}`, {
    method: "POST",
    headers: signedHeaders(creds, resource, body),
    body,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // capture-contexts returns the JWT as plain text
  }
  return { status: res.status, data: data as T };
}
