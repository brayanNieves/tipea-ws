import { db } from "../../config/firebase";

const PAYMENT_CONFIG_DOC = "appConfig/payment";

export interface PaymentConfig {
  /**
   * When true (default), createPaymentIntent converts DOP → USD using the
   * current exchange rate and charges in USD.
   * When false, charges the amount directly in DOP (no conversion).
   */
  chargeInUsd: boolean;

  /**
   * Gateway fee percentage charged ON TOP of the tip amount.
   * The customer pays `amount * (1 + feePct/100)`. Default: 7.
   * Valid range: [0, 100). Invalid values fall back to default.
   */
  feePct: number;
}

const DEFAULT_CONFIG: PaymentConfig = {
  chargeInUsd: false,
  feePct: 0,
};

export const paymentConfigRepo = {
  /**
   * Reads the payment config from Firestore.
   * Falls back to defaults if the doc doesn't exist, a field is missing,
   * or a field is out of range. Never throws — on read failure, returns
   * defaults so payments keep working.
   */
  async read(): Promise<PaymentConfig> {
    try {
      const snap = await db.doc(PAYMENT_CONFIG_DOC).get();
      if (!snap.exists) return DEFAULT_CONFIG;

      const data = snap.data() as Partial<PaymentConfig> | undefined;

      const chargeInUsd =
        typeof data?.chargeInUsd === "boolean"
          ? data.chargeInUsd
          : DEFAULT_CONFIG.chargeInUsd;

      const rawFeePct = data?.feePct;
      const feePct =
        typeof rawFeePct === "number" && rawFeePct >= 0 && rawFeePct < 100
          ? rawFeePct
          : DEFAULT_CONFIG.feePct;

      if (rawFeePct !== undefined && feePct === DEFAULT_CONFIG.feePct && rawFeePct !== DEFAULT_CONFIG.feePct) {
        console.warn(
          `[paymentConfigRepo.read] invalid feePct=${rawFeePct}; using default ${DEFAULT_CONFIG.feePct}`
        );
      }

      return { chargeInUsd, feePct };
    } catch (e) {
      console.warn("[paymentConfigRepo.read] failed, using defaults", e);
      return DEFAULT_CONFIG;
    }
  },
};
