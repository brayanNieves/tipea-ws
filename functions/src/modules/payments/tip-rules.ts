import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../../config/firebase";
import { MIN_TIP_DOP } from "./service-fee";

export interface TipRules {
  minTip: number;
  suggestedTips: number[];
  /** Business the rules came from; null when the global settings apply. */
  companyId: string | null;
}

export const DEFAULT_SUGGESTED_TIPS = [100, 150, 200, 250, 300];

function toAmounts(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0)
    : [];
}

/**
 * Minimum and suggested tips for a staff member: their active business
 * (/companies/{users.companyId}) first, then /config/tipSettings, then the
 * hardcoded defaults. Mirrored in client-tipapp's tip page.
 */
export async function resolveTipRules(
  staffSnap: FirebaseFirestore.DocumentSnapshot
): Promise<TipRules> {
  const companyId = staffSnap.get("companyId");
  if (typeof companyId === "string" && companyId) {
    const company = await db.doc(`companies/${companyId}`).get();
    if (company.exists && company.get("active") !== false) {
      const minTip = company.get("minTip");
      if (typeof minTip === "number" && minTip > 0) {
        return { minTip, suggestedTips: toAmounts(company.get("suggestedTips")), companyId };
      }
    }
  }

  const settings = await db.doc("config/tipSettings").get();
  const globalMin = settings.get("minTip");
  return {
    minTip: typeof globalMin === "number" && globalMin > 0 ? globalMin : MIN_TIP_DOP,
    suggestedTips: settings.exists ? toAmounts(settings.get("suggestedTips")) : DEFAULT_SUGGESTED_TIPS,
    companyId: null,
  };
}

/** Throws the same invalid-argument error every tip entry point used before. */
export async function assertMinTip(
  amount: number,
  staffSnap: FirebaseFirestore.DocumentSnapshot
): Promise<void> {
  const { minTip } = await resolveTipRules(staffSnap);
  if (amount < minTip) {
    throw new HttpsError("invalid-argument", `La propina mínima es RD$ ${minTip}.`);
  }
}
