/**
 * ============================================================================
 * src/services/BillingService.ts — ESTIMATES vs WHAT THE CLOUDS ACTUALLY BILLED
 * ============================================================================
 *
 * The app estimates costs every hour from list prices (USD, the `costs`
 * table). The real bill comes from each cloud, in the account's billing
 * currency, a few hours later:
 *
 *   AWS      Cost Explorer                 ce:GetCostAndUsage
 *   Azure    Cost Management query API     Cost Management Reader / Contributor
 *   Google   Cloud Billing export → BigQuery (one-time setup; table name saved here)
 *   Oracle   Usage API                     "read usage-report in tenancy"
 *
 * This service fetches month-to-date actuals (cached: AWS charges USD 0.01
 * per Cost Explorer request), stores them per day, converts to USD with the
 * ECB rate, and reconciles against the estimates for the same days. The
 * month projection uses actuals where the cloud has reported, estimates
 * for the days it hasn't yet, and that daily rate for the rest of the month.
 * ============================================================================
 */

import { query } from '../config/database';
import { CATALOGS, isProviderName } from '../providers/registry';
import { FriendlyCloudError, toFriendlyError, FriendlyError } from '../providers/errors';
import { listCredentialSummaries, providerFor } from './CredentialService';
import { getFxRates, toUsd, FxRates } from './FxService';

/** How long a fetch is reused: Cost Explorer costs money per request. */
const TTL_MS: Record<string, number> = { aws: 6 * 3600_000, azure: 3600_000, gcp: 3600_000, oracle: 3600_000 };
/** Even a manual refresh won't re-ask sooner than this. */
const MIN_REFRESH_MS: Record<string, number> = { aws: 30 * 60_000, azure: 5 * 60_000, gcp: 5 * 60_000, oracle: 5 * 60_000 };

const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export type BillingSettings = { exportTable?: string };

export async function getBillingSettings(userId: string, provider: string): Promise<BillingSettings> {
  const r = await query('SELECT settings FROM billing_settings WHERE user_id = $1 AND provider = $2', [userId, provider]);
  return r.rows[0]?.settings || {};
}

export async function saveBillingSettings(userId: string, provider: string, input: any): Promise<BillingSettings> {
  const settings: BillingSettings = {};
  if (provider === 'gcp') settings.exportTable = String(input?.exportTable || '').trim().replace(/`/g, '').slice(0, 300);
  await query(
    `INSERT INTO billing_settings (user_id, provider, settings, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, provider) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
    [userId, provider, JSON.stringify(settings)]
  );
  await query('DELETE FROM billing_fetches WHERE user_id = $1 AND provider = $2', [userId, provider]); // re-check with the new settings
  return settings;
}

/** Ask one cloud (unless a recent answer is stored) and store the days it reports. */
async function refreshCloud(userId: string, provider: string, monthStart: string, tomorrow: string, force: boolean) {
  const last = (await query('SELECT fetched_at FROM billing_fetches WHERE user_id = $1 AND provider = $2', [userId, provider])).rows[0];
  const age = last ? Date.now() - new Date(last.fetched_at).getTime() : Infinity;
  if (age < (force ? MIN_REFRESH_MS[provider] : TTL_MS[provider])) return;
  try {
    const cloud: any = await providerFor(userId, provider);
    if (typeof cloud.getBillingActuals !== 'function') throw new FriendlyCloudError({ code: 'BILLING_UNSUPPORTED', title: 'Not supported for this cloud yet', explanation: '', fixes: [] });
    const settings = await getBillingSettings(userId, provider);
    const actual = await cloud.getBillingActuals(monthStart, tomorrow, settings);
    const accountByDate = new Map((actual.accountDaily || []).map((d: any) => [d.date, d.amount]));
    const dates = new Set<string>([...actual.daily.map((d: any) => d.date), ...accountByDate.keys()] as string[]);
    for (const date of dates) {
      const amount = actual.daily.find((d: any) => d.date === date)?.amount ?? 0;
      await query(
        `INSERT INTO billing_actuals (user_id, provider, date, currency, amount, account_amount, fetched_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (user_id, provider, date) DO UPDATE SET currency = EXCLUDED.currency, amount = EXCLUDED.amount, account_amount = EXCLUDED.account_amount, fetched_at = NOW()`,
        [userId, provider, date, actual.currency, amount, accountByDate.has(date) ? accountByDate.get(date) : null]
      );
    }
    await query(
      `INSERT INTO billing_fetches (user_id, provider, fetched_at, ok, currency, scope, scope_note, notes, error) VALUES ($1, $2, NOW(), true, $3, $4, $5, $6, NULL)
       ON CONFLICT (user_id, provider) DO UPDATE SET fetched_at = NOW(), ok = true, currency = EXCLUDED.currency, scope = EXCLUDED.scope, scope_note = EXCLUDED.scope_note, notes = EXCLUDED.notes, error = NULL`,
      [userId, provider, actual.currency, actual.scope, actual.scopeNote, JSON.stringify(actual.notes || [])]
    );
  } catch (error) {
    const friendly: FriendlyError = toFriendlyError(error, provider);
    console.error(`[Billing] ${provider}:`, friendly.title);
    await query(
      `INSERT INTO billing_fetches (user_id, provider, fetched_at, ok, error) VALUES ($1, $2, NOW(), false, $3)
       ON CONFLICT (user_id, provider) DO UPDATE SET fetched_at = NOW(), ok = false, error = EXCLUDED.error`,
      [userId, provider, JSON.stringify(friendly)]
    );
  }
}

export interface CloudReconciliation {
  provider: string;
  label: string;
  status: 'ok' | 'needs-setup' | 'error' | 'not-connected';
  error?: FriendlyError;
  fetchedAt?: string;
  currency?: string;                 // billing currency, as the cloud reports it
  scope?: string; scopeNote?: string; notes?: string[];
  settings?: BillingSettings;
  dataThrough?: string;              // last day the cloud has reported (UTC)
  actual?: { amount: number; currency: string; usd: number | null };          // month to date, through dataThrough
  accountActual?: { amount: number; currency: string; usd: number | null };   // whole account, if narrower scope
  estimateSameDaysUsd: number;       // the app's estimate for the same days
  estimateMonthUsd: number;          // the app's estimate for the whole month so far
  differenceUsd: number | null;      // actual − estimate (same days)
  differencePct: number | null;
  daily: Array<{ date: string; estimateUsd: number; actual: number | null; actualUsd: number | null }>;
}

export async function getReconciliation(userId: string, refresh = false) {
  const now = new Date();
  const monthStartD = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthStart = iso(monthStartD);
  const tomorrow = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)));
  const today = iso(now);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const daysElapsed = now.getUTCDate();

  const connected = new Set((await listCredentialSummaries(userId)).map((c) => c.provider).filter(isProviderName));
  await Promise.all([...connected].map((p) => refreshCloud(userId, p, monthStart, tomorrow, refresh)));
  const fx = await getFxRates();

  // The app's estimates (USD) per cloud and day, this month.
  const est = await query(
    `SELECT provider, to_char(date, 'YYYY-MM-DD') AS d, SUM(compute_cost + egress_cost + storage_cost) AS usd
     FROM costs WHERE user_id = $1 AND date >= $2 GROUP BY provider, d`, [userId, monthStart]);
  const estimate = new Map<string, number>(est.rows.map((r: any) => [`${r.provider}:${r.d}`, Number(r.usd) || 0]));
  const acts = await query(
    `SELECT provider, to_char(date, 'YYYY-MM-DD') AS d, currency, amount, account_amount FROM billing_actuals
     WHERE user_id = $1 AND date >= $2 ORDER BY date`, [userId, monthStart]);
  const fetches = await query('SELECT * FROM billing_fetches WHERE user_id = $1', [userId]);
  const settingsRows = await query('SELECT provider, settings FROM billing_settings WHERE user_id = $1', [userId]);

  const days: string[] = [];
  for (let d = new Date(monthStartD); iso(d) <= today; d.setUTCDate(d.getUTCDate() + 1)) days.push(iso(d));

  const clouds: CloudReconciliation[] = Object.values(CATALOGS).map((c) => {
    const p = c.provider;
    const f = fetches.rows.find((x: any) => x.provider === p);
    const mine = acts.rows.filter((x: any) => x.provider === p);
    const currency = f?.currency || mine[mine.length - 1]?.currency;
    const estFor = (list: string[]) => r2(list.reduce((s, d) => s + (estimate.get(`${p}:${d}`) || 0), 0));
    const base: CloudReconciliation = {
      provider: p, label: c.label,
      status: !connected.has(p) ? 'not-connected' : f && !f.ok ? (/SETUP|PERMISSION/.test(f.error?.code || '') ? 'needs-setup' : 'error') : 'ok',
      error: f && !f.ok ? f.error : undefined,
      fetchedAt: f?.fetched_at, currency, scope: f?.scope, scopeNote: f?.scope_note, notes: f?.notes || [],
      settings: settingsRows.rows.find((x: any) => x.provider === p)?.settings,
      estimateSameDaysUsd: 0, estimateMonthUsd: estFor(days), differenceUsd: null, differencePct: null,
      daily: days.map((d) => ({ date: d, estimateUsd: r2(estimate.get(`${p}:${d}`) || 0), actual: null, actualUsd: null })),
    };
    if (!mine.length || !currency) return base;
    // Clouds report with a delay: trust days up to yesterday that the cloud has
    // returned. Today is always incomplete.
    const reported = mine.map((x: any) => x.d).filter((d: string) => d < today);
    const dataThrough = reported.length ? reported[reported.length - 1] : undefined;
    if (!dataThrough) return base;
    const window = days.filter((d) => d <= dataThrough);
    const sum = (key: 'amount' | 'account_amount') => mine.filter((x: any) => x.d <= dataThrough).reduce((s: number, x: any) => s + (Number(x[key]) || 0), 0);
    const amount = r2(sum('amount'));
    const usd = toUsd(amount, currency, fx);
    const estimateSame = estFor(window);
    const hasAccount = mine.some((x: any) => x.account_amount !== null);
    const accountAmount = hasAccount ? r2(sum('account_amount')) : null;
    return {
      ...base, dataThrough,
      actual: { amount, currency, usd: usd === null ? null : r2(usd) },
      accountActual: accountAmount === null ? undefined : { amount: accountAmount, currency, usd: toUsd(accountAmount, currency, fx) === null ? null : r2(toUsd(accountAmount, currency, fx)!) },
      estimateSameDaysUsd: estimateSame,
      differenceUsd: usd === null ? null : r2(usd - estimateSame),
      differencePct: usd === null || estimateSame === 0 ? null : Math.round(((usd - estimateSame) / estimateSame) * 100),
      daily: base.daily.map((row) => {
        const a = mine.find((x: any) => x.d === row.date);
        if (!a || row.date > dataThrough) return row;
        const v = Number(a.amount) || 0;
        const vu = toUsd(v, currency, fx);
        return { ...row, actual: r2(v), actualUsd: vu === null ? null : r2(vu) };
      }),
    };
  });

  // Month projection (USD): actual where reported, estimate for the rest so
  // far, then this month's daily rate for the remaining days.
  let knownUsd = 0;
  let estimatedUsd = 0;
  for (const c of clouds) {
    if (c.actual?.usd != null && c.dataThrough) {
      knownUsd += c.actual.usd;
      estimatedUsd += c.daily.filter((d) => d.date > c.dataThrough!).reduce((s, d) => s + d.estimateUsd, 0);
    } else {
      estimatedUsd += c.estimateMonthUsd;
    }
  }
  const soFarUsd = knownUsd + estimatedUsd;
  const dailyRate = soFarUsd / Math.max(daysElapsed, 1);
  const projectedUsd = soFarUsd + dailyRate * (daysInMonth - daysElapsed);

  return {
    generatedAt: new Date().toISOString(),
    month: monthStart.slice(0, 7),
    estimateCurrency: 'USD',
    fx: fx ? { base: fx.base, date: fx.date, source: fx.source, rates: pickRates(fx) } : null,
    clouds,
    forecast: {
      currency: 'USD',
      soFarUsd: r2(soFarUsd), fromActualsUsd: r2(knownUsd), fromEstimatesUsd: r2(estimatedUsd),
      dailyRateUsd: r2(dailyRate), projectedUsd: r2(projectedUsd), daysElapsed, daysInMonth,
      basis: knownUsd > 0 ? (estimatedUsd > 0 ? 'mixed' : 'actual') : 'estimate',
    },
  };
}

/** The currencies worth offering in "also show in". */
function pickRates(fx: FxRates) {
  const want = ['USD', 'SGD', 'AUD', 'EUR', 'GBP', 'JPY', 'KRW', 'HKD', 'INR', 'MYR', 'PHP', 'CAD', 'NZD'];
  return Object.fromEntries(want.filter((c) => fx.rates[c]).map((c) => [c, fx.rates[c]]));
}
