import { db } from "../../config/firebase";

const PAYMENT_CONFIG_DOC = "appConfig/payment";

export interface PaymentConfig {
  /**
   * When true (default), createPaymentIntent converts DOP → USD using the
   * current exchange rate and charges in USD.
   * When false, charges the amount directly in DOP (no conversion).
   */
  chargeInUsd: boolean;
}

const DEFAULT_CONFIG: PaymentConfig = {
  chargeInUsd: true,
};

export const paymentConfigRepo = {
  /**
   * Reads the payment config from Firestore.
   * Falls back to defaults if the doc doesn't exist or the field is missing.
   * Never throws — on read failure, returns defaults so payments keep working.
   */
  async read(): Promise<PaymentConfig> {
    try {
      const snap = await db.doc(PAYMENT_CONFIG_DOC).get();
      if (!snap.exists) return DEFAULT_CONFIG;

      const data = snap.data() as Partial<PaymentConfig> | undefined;
      return {
        chargeInUsd:
          typeof data?.chargeInUsd === "boolean"
            ? data.chargeInUsd
            : DEFAULT_CONFIG.chargeInUsd,
      };
    } catch (e) {
      console.warn("[paymentConfigRepo.read] failed, using defaults", e);
      return DEFAULT_CONFIG;
    }
  },
};
