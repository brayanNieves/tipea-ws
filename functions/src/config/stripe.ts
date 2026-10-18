import { defineSecret } from "firebase-functions/params";
import type { Stripe as StripeClient } from "stripe";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StripeLib = require("stripe") as new (key: string) => StripeClient;

export const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

/**
 * Builds a Stripe client using the runtime secret value.
 * Must be called *inside* a function handler — secrets are not
 * resolved at module-load time.
 */
export function buildStripeClient(): StripeClient {
  const key = stripeSecretKey.value();
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY not configured");
  }
  return new StripeLib(key);
}
