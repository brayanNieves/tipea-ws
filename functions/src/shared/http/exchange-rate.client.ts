const EXCHANGE_RATE_URL = "https://open.er-api.com/v6/latest/USD";

export interface ExchangeRateResponse {
  result?: string;
  rates?: Record<string, number>;
}

/**
 * Fetches latest USD-based exchange rates from open.er-api.com.
 * Throws on non-2xx or invalid response.
 */
export async function fetchUsdRates(): Promise<ExchangeRateResponse> {
  const res = await fetch(EXCHANGE_RATE_URL);
  if (!res.ok) {
    throw new Error(`exchange-rate http ${res.status}`);
  }
  return (await res.json()) as ExchangeRateResponse;
}
