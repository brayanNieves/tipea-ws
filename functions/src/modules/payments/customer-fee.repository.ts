import { db } from "../../config/firebase";
import { DEFAULT_CUSTOMER_FEE, type CustomerFeeConfig } from "./service-fee";

const CUSTOMER_FEE_DOC = "config/customerFee";

export const customerFeeRepo = {
  /**
   * Reads the customer fee from Firestore. The admin edits it at
   * /admin/fee-config in the backoffice.
   *
   * Never throws: if the doc doesn't exist, or a field is missing or invalid,
   * it falls back to DEFAULT_CUSTOMER_FEE so payments keep working.
   */
  async read(): Promise<CustomerFeeConfig> {
    try {
      const snap = await db.doc(CUSTOMER_FEE_DOC).get();
      if (!snap.exists) return DEFAULT_CUSTOMER_FEE;

      const data = snap.data() as Partial<CustomerFeeConfig> | undefined;

      const rawPct = data?.percentageFee;
      const percentageFee =
        typeof rawPct === "number" && Number.isFinite(rawPct) && rawPct >= 0 && rawPct < 100
          ? rawPct
          : DEFAULT_CUSTOMER_FEE.percentageFee;

      const rawFixed = data?.fixedFee;
      const fixedFee =
        typeof rawFixed === "number" && Number.isFinite(rawFixed) && rawFixed >= 0
          ? rawFixed
          : DEFAULT_CUSTOMER_FEE.fixedFee;

      if (rawPct !== undefined && rawPct !== percentageFee) {
        console.warn(
          `[customerFeeRepo.read] invalid percentageFee=${rawPct}; using ${percentageFee}`
        );
      }
      if (rawFixed !== undefined && rawFixed !== fixedFee) {
        console.warn(
          `[customerFeeRepo.read] invalid fixedFee=${rawFixed}; using ${fixedFee}`
        );
      }

      return { percentageFee, fixedFee };
    } catch (e) {
      console.warn("[customerFeeRepo.read] read failed, using defaults", e);
      return DEFAULT_CUSTOMER_FEE;
    }
  },
};
