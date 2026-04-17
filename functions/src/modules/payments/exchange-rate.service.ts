import { fetchUsdRates } from "../../shared/http/exchange-rate.client";
import { exchangeRateRepo } from "./exchange-rate.repository";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_DOP_RATE = 59;

export type RateSource = "cache" | "api" | "fallback";

/**
 * Returns the current USD→DOP rate.
 * Resolution order:
 *   1. Firestore cache if fresh (< 24h).
 *   2. Public exchange rate API (persists to cache on success).
 *   3. Hardcoded fallback rate.
 */
export async function getUsdToDopRate(): Promise<{ rate: number; source: RateSource }> {
  // 1) Try Firestore cache
  try {
    const cached = await exchangeRateRepo.read();
    if (
      cached &&
      typeof cached.rate === "number" &&
      cached.rate > 0 &&
      typeof cached.fetchedAt === "number" &&
      Date.now() - cached.fetchedAt < ONE_DAY_MS
    ) {
      return { rate: cached.rate, source: "cache" };
    }
  } catch (e) {
    console.warn("[getUsdToDopRate] cache read failed", e);
  }

  // 2) Call the public exchange rate API
  try {
    const json = await fetchUsdRates();
    const dop = json?.rates?.DOP;
    if (json.result !== "success" || typeof dop !== "number" || dop <= 0) {
      throw new Error("invalid response");
    }
    await exchangeRateRepo.write(dop);
    return { rate: dop, source: "api" };
  } catch (e) {
    console.warn("[getUsdToDopRate] api failed, using fallback", e);
    return { rate: FALLBACK_DOP_RATE, source: "fallback" };
  }
}
