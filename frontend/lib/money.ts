/**
 * lib/money.ts — every amount says its currency.
 *
 * The app's own figures are ESTIMATES from cloud list prices, in USD.
 * What a cloud actually bills is in the account's billing currency (e.g.
 * SGD), and is shown in that currency. ISO codes, never a bare "$".
 */
const NO_DECIMALS = new Set(['JPY', 'KRW', 'IDR', 'VND']);

/** e.g. money(12.3, 'SGD') → "SGD 12.30"; money(0.66) → "USD 0.66". */
export function money(amount: number | string | null | undefined, currency = 'USD', decimals?: number): string {
  const n = Number(amount) || 0;
  const d = decimals ?? (NO_DECIMALS.has(currency) ? 0 : 2);
  return `${currency} ${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

/** USD estimate helper: usd(0.66) → "USD 0.66". */
export const usd = (amount: number | string | null | undefined, decimals?: number) => money(amount, 'USD', decimals);

/** Convert a USD amount with rates where 1 USD = rates[X] of X. */
export function fromUsd(amountUsd: number, currency: string, rates?: Record<string, number> | null): number | null {
  if (currency === 'USD') return amountUsd;
  const r = rates?.[currency];
  return r ? amountUsd * r : null;
}

/** A range in one currency: usdRange(0.87, 4.35) → "USD 0.87–4.35". */
export function usdRange(low: number, high: number): string {
  return `${usd(low)}–${usd(high).replace(/^USD /, '')}`;
}
