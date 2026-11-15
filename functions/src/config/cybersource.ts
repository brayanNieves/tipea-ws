import { defineSecret, defineString } from "firebase-functions/params";

// REST credentials (Business Center → Key Management → REST – Shared Secret).
export const cybersourceMerchantId = defineSecret("CYBERSOURCE_MERCHANT_ID");
export const cybersourceApiKeyId = defineSecret("CYBERSOURCE_API_KEY_ID");
export const cybersourceSecretKey = defineSecret("CYBERSOURCE_SECRET_KEY");

export const cybersourceSecrets = [
  cybersourceMerchantId,
  cybersourceApiKeyId,
  cybersourceSecretKey,
];

// Non-secret params (functions/.env).
export const cybersourceApiHost = defineString("CYBERSOURCE_API_HOST", {
  default: "apitest.cybersource.com",
});

// CSV of origins allowed to render Unified Checkout. The Apple Pay domain
// MUST go first: Apple Pay only accepts a single target origin.
export const cybersourceTargetOrigins = defineString("CYBERSOURCE_TARGET_ORIGINS", {
  default: "https://tipapp.tech",
});

// How the shared secret is encoded. Cybersource REST secrets are base64.
export const cybersourceSecretEncoding = defineString("CYBERSOURCE_SECRET_ENCODING", {
  default: "base64",
});

export interface CybersourceCredentials {
  host: string;
  merchantId: string;
  apiKeyId: string;
  secretKey: Buffer;
}

/**
 * Resolves the credentials at runtime. Must be called *inside* a function
 * handler — secrets are not resolved at module-load time.
 */
export function readCybersourceCredentials(): CybersourceCredentials {
  const merchantId = cybersourceMerchantId.value();
  const apiKeyId = cybersourceApiKeyId.value();
  const secret = cybersourceSecretKey.value();
  if (!merchantId || !apiKeyId || !secret) {
    throw new Error("Cybersource credentials not configured");
  }
  const encoding = cybersourceSecretEncoding.value() === "hex" ? "hex" : "base64";
  return {
    host: cybersourceApiHost.value(),
    merchantId,
    apiKeyId,
    secretKey: Buffer.from(secret, encoding),
  };
}

export function readTargetOrigins(): string[] {
  const origins = cybersourceTargetOrigins
    .value()
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // Cybersource rejects non-https origins with "400 Invalid URL".
  const httpsOrigins = origins.filter((o) => o.startsWith("https://"));
  if (httpsOrigins.length !== origins.length) {
    console.warn(
      `[cybersource] ignoring non-https target origins: ${origins
        .filter((o) => !o.startsWith("https://"))
        .join(", ")}`
    );
  }
  return httpsOrigins;
}
