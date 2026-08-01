import { db } from "../../config/firebase";
import { DEFAULT_CUSTOMER_FEE, type CustomerFeeConfig } from "./service-fee";

const CUSTOMER_FEE_DOC = "config/customerFee";

export const customerFeeRepo = {
  /**
   * Lee el fee al cliente desde Firestore. Lo edita el admin en
   * /admin/fee-config (backoffice).
   *
   * Nunca lanza: si el doc no existe, un campo falta o es inválido, cae a
   * DEFAULT_CUSTOMER_FEE para que los pagos sigan funcionando.
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
          `[customerFeeRepo.read] percentageFee inválido=${rawPct}; usando ${percentageFee}`
        );
      }
      if (rawFixed !== undefined && rawFixed !== fixedFee) {
        console.warn(
          `[customerFeeRepo.read] fixedFee inválido=${rawFixed}; usando ${fixedFee}`
        );
      }

      return { percentageFee, fixedFee };
    } catch (e) {
      console.warn("[customerFeeRepo.read] falló la lectura, usando defaults", e);
      return DEFAULT_CUSTOMER_FEE;
    }
  },
};
