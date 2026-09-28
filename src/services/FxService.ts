/**
 * ============================================================================
 * src/services/FxService.ts — EXCHANGE RATES (so every amount says its currency)
 * ============================================================================
 *
 * The app's estimates are in USD (cloud list prices are USD). Clouds bill in
 * the account's currency (e.g. SGD). To compare them, and to show totals in
 * another currency, we use the European Central Bank's daily reference
 * rates via Frankfurter (free, no key). Cached for 12 hours; if the service
 * is unreachable, amounts are shown in their own currency only.
 * ============================================================================
 */

export interface FxRates {
  base: 'USD';
  date: string;                      // the ECB rate date
  source: string;
  rates: Record<string, number>;     // 1 USD = rates[X] of currency X
}

let cached: { at: number; value: FxRates } | null = null;
const TTL = 12 * 60 * 60 * 1000;

export async function getFxRates(): Promise<FxRates | null> {
  if (cached && Date.now() - cached.at < TTL) return cached.value;
  const urls = ['https://api.frankfurter.dev/v1/latest?base=USD', 'https://api.frankfurter.app/latest?from=USD'];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const json: any = await res.json();
      if (!json?.rates) continue;
      const value: FxRates = { base: 'USD', date: String(json.date), source: 'European Central Bank reference rates (via Frankfurter)', rates: { USD: 1, ...json.rates } };
      cached = { at: Date.now(), value };
      return value;
    } catch { /* try the next */ }
  }
  // Fallback: open.er-api.com (free, daily rates, no key).
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(6000) });
    const json: any = res.ok ? await res.json() : null;
    if (json?.result === 'success' && json.rates) {
      const value: FxRates = { base: 'USD', date: String(json.time_last_update_utc || '').slice(5, 16), source: 'ExchangeRate-API (open.er-api.com)', rates: json.rates };
      cached = { at: Date.now(), value };
      return value;
    }
  } catch { /* offline */ }
  return cached?.value || null;
}

/** amount in `currency` → USD, or null if the rate isn't known. */
export function toUsd(amount: number, currency: string, fx: FxRates | null): number | null {
  if (currency === 'USD') return amount;
  const rate = fx?.rates[currency];
  return rate ? amount / rate : null;
}
