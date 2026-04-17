import { admin, db } from "../../config/firebase";

export interface SuspicionInput {
  userId: string;
  amount: number;
  source?: string;
}

export interface SuspicionResult {
  isSuspicious: boolean;
  reasons: string[];
}

/**
 * Detects suspicious patterns in a newly-created tip.
 * Rules:
 *  - Unusually high amount (> RD$5000)
 *  - >1 tips from same user in the last 5 minutes
 *  - Suspiciously round amount (>= RD$1000 and multiple of 1000)
 *  - Manual (no-QR) tip > RD$2000
 */
export async function evaluateTip(input: SuspicionInput): Promise<SuspicionResult> {
  const reasons: string[] = [];

  if (input.amount > 5000) {
    reasons.push(`Unusually high tip amount: RD$ ${input.amount}`);
  }

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const recentTipsSnap = await db
    .collection("tips")
    .where("userId", "==", input.userId)
    .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(fiveMinutesAgo))
    .get();

  if (recentTipsSnap.size > 1) {
    reasons.push(`${recentTipsSnap.size} tips submitted within 5 minutes`);
  }

  if (input.amount >= 1000 && input.amount % 1000 === 0) {
    reasons.push(`Suspiciously round amount: RD$ ${input.amount}`);
  }

  if (input.source === "manual" && input.amount > 2000) {
    reasons.push(`High manual tip (no QR): RD$ ${input.amount}`);
  }

  return { isSuspicious: reasons.length > 0, reasons };
}
