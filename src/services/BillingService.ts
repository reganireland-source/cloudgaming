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
import type { CloudInvoices } from '../providers/shared/types';
import { RESOURCE_TAG } from '../providers/shared/streaming';

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
    // AWS bills USD 0.01 per Cost Explorer request, and this fetch makes two
    // (whole account + this app's tag): part of what AWS charges, so count it.
    if (provider === 'aws') {
      await query(`INSERT INTO costs (user_id, machine_id, provider, compute_cost, egress_cost, storage_cost, date) VALUES ($1, NULL, 'aws', 0.02, 0, 0, CURRENT_DATE)`, [userId]).catch(() => undefined);
    }
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
      `INSERT INTO billing_fetches (user_id, provider, fetched_at, ok, currency, scope, scope_note, notes, error, breakdown) VALUES ($1, $2, NOW(), true, $3, $4, $5, $6, NULL, $7)
       ON CONFLICT (user_id, provider) DO UPDATE SET fetched_at = NOW(), ok = true, currency = EXCLUDED.currency, scope = EXCLUDED.scope, scope_note = EXCLUDED.scope_note, notes = EXCLUDED.notes, error = NULL, breakdown = EXCLUDED.breakdown`,
      [userId, provider, actual.currency, actual.scope, actual.scopeNote, JSON.stringify(actual.notes || []), actual.breakdown ? JSON.stringify(actual.breakdown) : null]
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
  /** The cloud's own line items (billing currency), when it reports them. */
  breakdown?: Array<{ service: string; item: string; amount: number; usage?: number | null; unit?: string | null; category: string }>;
  /** The app's estimate for the same days, by what it covers (USD). */
  estimateParts?: { computeUsd: number; egressUsd: number; storageUsd: number };
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
    `SELECT provider, to_char(date, 'YYYY-MM-DD') AS d, SUM(compute_cost + egress_cost + storage_cost) AS usd,
            SUM(compute_cost) AS compute, SUM(egress_cost) AS egress, SUM(storage_cost) AS storage
     FROM costs WHERE user_id = $1 AND date >= $2 GROUP BY provider, d`, [userId, monthStart]);
  const estRows = est.rows as Array<{ provider: string; d: string; compute: string; egress: string; storage: string }>;
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
      breakdown: f?.breakdown || undefined,
      estimateParts: (() => {
        const rows = estRows.filter((x) => x.provider === p && x.d <= dataThrough);
        const add = (k: 'compute' | 'egress' | 'storage') => r2(rows.reduce((s, x) => s + (Number(x[k]) || 0), 0));
        return { computeUsd: add('compute'), egressUsd: add('egress'), storageUsd: add('storage') };
      })(),
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

/**
 * The short spend summary shown in the status strip on every page:
 * today, week to date (weeks start Monday), month to date, the month
 * projection, and what running machines cost per hour right now. All USD,
 * all UTC days. Cheap: reads only what's stored (no cloud calls) — actual
 * charges already fetched by the daily job or the Costs page, and the app's
 * estimates for any day a cloud hasn't billed yet.
 */
export async function getSpendSummary(userId: string) {
  const now = new Date();
  const day = (offset: number) => iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)));
  const today = day(0);
  const weekStart = day(-((now.getUTCDay() + 6) % 7));
  const monthStart = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const from = weekStart < monthStart ? weekStart : monthStart;
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

  const [est, acts, fetches, running, fx] = await Promise.all([
    query(`SELECT provider, to_char(date, 'YYYY-MM-DD') AS d, SUM(compute_cost + egress_cost + storage_cost) AS usd
           FROM costs WHERE user_id = $1 AND date >= $2 GROUP BY provider, d`, [userId, from]),
    query(`SELECT provider, to_char(date, 'YYYY-MM-DD') AS d, currency, amount FROM billing_actuals
           WHERE user_id = $1 AND date >= $2 AND date < $3`, [userId, from, today]),
    query('SELECT provider, ok FROM billing_fetches WHERE user_id = $1', [userId]),
    query(`SELECT COALESCE(SUM(cost_per_hour), 0) AS h FROM machines WHERE user_id = $1 AND status = 'running'`, [userId]),
    getFxRates(),
  ]);

  // Per cloud and day: the billed amount (USD) where the cloud has reported
  // that day and its last fetch worked, otherwise the app's estimate.
  const ok = new Set(fetches.rows.filter((f: any) => f.ok).map((f: any) => f.provider));
  const cell = new Map<string, { usd: number; billed: boolean }>();
  for (const r of est.rows) cell.set(`${r.provider}:${r.d}`, { usd: Number(r.usd) || 0, billed: false });
  for (const a of acts.rows) {
    if (!ok.has(a.provider)) continue;
    const u = toUsd(Number(a.amount) || 0, a.currency, fx);
    if (u !== null) cell.set(`${a.provider}:${a.d}`, { usd: u, billed: true });
  }
  const total = (start: string) => {
    let usd = 0; let billed = 0;
    for (const [k, v] of cell) if (k.slice(k.indexOf(':') + 1) >= start) { usd += v.usd; if (v.billed) billed += v.usd; }
    return { usd: r2(usd), billedUsd: r2(billed) };
  };
  const month = total(monthStart);
  const daysElapsed = now.getUTCDate();
  return {
    currency: 'USD' as const,
    today: total(today),
    weekToDate: { ...total(weekStart), since: weekStart },
    monthToDate: { ...month, since: monthStart },
    projectedMonthUsd: r2((month.usd / Math.max(daysElapsed, 1)) * daysInMonth),
    runningPerHourUsd: r2(Number(running.rows[0].h) || 0),
    generatedAt: now.toISOString(),
  };
}

// ============================================================================
// INVOICES (what you owe, and when) and BILLING ACCESS (how to switch it on)
// ============================================================================


const INVOICE_TTL_MS = 6 * 3600_000;
const invoiceCache = new Map<string, { at: number; value: CloudInvoiceResult }>();

export interface CloudInvoiceResult extends Partial<CloudInvoices> {
  provider: string;
  label: string;
  status: 'ok' | 'needs-setup' | 'error' | 'not-connected';
  error?: FriendlyError;
  checkedAt?: string;
}

/** Each connected cloud's recent invoices (cached 6 h; refresh asks again). */
export async function getInvoices(userId: string, refresh = false): Promise<CloudInvoiceResult[]> {
  const connected = new Set((await listCredentialSummaries(userId)).map((c) => c.provider));
  return Promise.all((['aws', 'azure', 'gcp', 'oracle'] as const).map(async (p): Promise<CloudInvoiceResult> => {
    const label = CATALOGS[p].label;
    if (!connected.has(p)) return { provider: p, label, status: 'not-connected' };
    const key = `${userId}:${p}`;
    const hit = invoiceCache.get(key);
    if (!refresh && hit && Date.now() - hit.at < INVOICE_TTL_MS) return hit.value;
    let value: CloudInvoiceResult;
    try {
      const cloud: any = await providerFor(userId, p);
      if (typeof cloud.getInvoices !== 'function') throw new FriendlyCloudError({ code: 'BILLING_UNSUPPORTED', title: 'Not supported for this cloud yet', explanation: '', fixes: [] });
      const r: CloudInvoices = await cloud.getInvoices(await getBillingSettings(userId, p));
      value = { provider: p, label, status: 'ok', ...r, checkedAt: new Date().toISOString() };
    } catch (error) {
      const f = error instanceof FriendlyCloudError ? error.friendly : toFriendlyError(error, p);
      value = { provider: p, label, status: /SETUP|PERMISSION/.test(f.code || '') ? 'needs-setup' : 'error', error: f, checkedAt: new Date().toISOString() };
    }
    invoiceCache.set(key, { at: Date.now(), value });
    return value;
  }));
}

export interface BillingAccess {
  provider: string;
  label: string;
  connected: boolean;
  /** Where to run the commands. */
  shell: { name: string; url: string };
  /** What it switches on, in plain words. */
  summary: string;
  steps: string[];
  /** One complete command per line, filled in with this account's ids. */
  cli: string;
  consoleUrl: string;
  consoleLabel: string;
  notes?: string[];
}

/**
 * How to give the app read access to actual costs and invoices, per cloud,
 * with the commands filled in from the saved keys (account / subscription
 * / project / tenancy ids — none of them secret).
 */
export async function getBillingAccess(userId: string): Promise<BillingAccess[]> {
  const saved = await listCredentialSummaries(userId);
  const meta = (p: string) => (saved.find((s) => s.provider === p)?.metadata || {}) as Record<string, any>;
  const has = (p: string) => saved.some((s) => s.provider === p);
  const aws = meta('aws'), az = meta('azure'), g = meta('gcp'), o = meta('oracle');

  const awsUser = String(aws.arn || '').match(/:user\/(?:.*\/)?([^/]+)$/)?.[1] || 'cloudgaming-hub';
  const sub = az.subscriptionId || '<subscription-id>';
  const appId = az.clientId || '<app-client-id>';
  const project = g.projectId || '<your-project-id>';
  const sa = g.clientEmail || '<service-account-email>';
  const tenancy = o.tenancyOcid || '<tenancy-ocid>';

  return [
    {
      provider: 'aws', label: CATALOGS.aws.label, connected: has('aws'),
      shell: { name: 'AWS CloudShell', url: 'https://console.aws.amazon.com/cloudshell/home' },
      summary: 'Actual daily costs (Cost Explorer) and your invoices with due dates (Invoicing).',
      steps: [
        'First, once per account (console only): signed in as the ROOT user, Account → "IAM user and role access to Billing information" → Edit → Activate. Without it no IAM user (CloudShell or the app) can see billing.',
        'Then open Billing and Cost Management → Cost Explorer once: that switches Cost Explorer on. AWS prepares the data for up to 24 hours ("User not enabled for cost explorer access" until then).',
        `Run the first command in AWS CloudShell as an administrator (not as the app's key): it lets the app's IAM user "${awsUser}" read costs and invoices. The second switches on the "${RESOURCE_TAG.key}" cost tag (app-only costs); it only works once Cost Explorer is on, and the app also tries it by itself.`,
        'Payments are taken from the card on file on or after each invoice\'s due date (Billing → Payments shows what\'s paid).',
      ],
      cli: [
        `aws iam put-user-policy --user-name ${awsUser} --policy-name cloudgaming-billing --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["ce:GetCostAndUsage","ce:UpdateCostAllocationTagsStatus","invoicing:ListInvoiceSummaries"],"Resource":"*"}]}'`,
        `aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=${RESOURCE_TAG.key},Status=Active`,
      ].join('\n'),
      consoleUrl: 'https://console.aws.amazon.com/cost-management/home#/cost-explorer', consoleLabel: 'Open Cost Explorer',
    },
    {
      provider: 'azure', label: CATALOGS.azure.label, connected: has('azure'),
      shell: { name: 'Azure Cloud Shell (Bash)', url: 'https://portal.azure.com/#cloudshell/' },
      summary: 'Actual daily costs (Cost Management) and your invoices (Billing).',
      steps: [
        'Run the commands in Azure Cloud Shell as the subscription owner: they give the app\'s identity read access to cost data and to this subscription\'s billing.',
        'Invoices with amounts and due dates (Microsoft Customer Agreement — most Pay-As-You-Go sign-ups since 2020) also need a billing role: Cost Management + Billing → Billing scopes → your billing account → Billing profiles → your profile → Access control (IAM) → Add → "Billing profile reader" → search the app\'s name (the app registration you created for the keys) → Add.',
        'Free-trial, student and sponsorship subscriptions don\'t offer cost or invoice data through the API; Pay-As-You-Go does.',
      ],
      cli: [
        `az role assignment create --assignee ${appId} --role "Cost Management Reader" --scope /subscriptions/${sub}`,
        `az role assignment create --assignee ${appId} --role "Billing Reader" --scope /subscriptions/${sub}`,
      ].join('\n'),
      consoleUrl: 'https://portal.azure.com/#view/Microsoft_Azure_GTM/ModernBillingMenuBlade/~/BillingAccounts', consoleLabel: 'Open Billing accounts',
      notes: ['Older (MOSP) Pay-As-You-Go accounts list invoices without amounts or due dates through the API; the card on file is charged when each invoice is issued.'],
    },
    {
      provider: 'gcp', label: CATALOGS.gcp.label, connected: has('gcp'),
      shell: { name: 'Google Cloud Shell', url: 'https://shell.cloud.google.com/' },
      summary: 'Actual daily costs and per-invoice-month totals, from the billing export to BigQuery (Google has no cost or invoice API).',
      steps: [
        'Run the commands in Cloud Shell: they turn on BigQuery, create a dataset "billing_export" and let the app\'s service account read it.',
        'Then the one step Google only offers in the console: Billing → Billing export → BigQuery export → "Standard usage cost" → Edit settings → project ' + project + ', dataset "billing_export" → Save.',
        'Data starts from that day and appears within a few hours. The app finds the export table by itself — nothing to paste.',
        'Due dates aren\'t available from Google: self-serve accounts are charged automatically at the start of each month (or at a threshold); invoiced accounts follow their payment terms.',
      ],
      cli: [
        `gcloud services enable bigquery.googleapis.com bigquerydatatransfer.googleapis.com --project=${project}`,
        `bq --project_id=${project} mk --dataset --location=US ${project}:billing_export`,
        `gcloud projects add-iam-policy-binding ${project} --member=serviceAccount:${sa} --role=roles/bigquery.jobUser --condition=None`,
        `gcloud projects add-iam-policy-binding ${project} --member=serviceAccount:${sa} --role=roles/bigquery.dataViewer --condition=None`,
      ].join('\n'),
      consoleUrl: 'https://console.cloud.google.com/billing/export', consoleLabel: 'Open Billing export',
    },
    {
      provider: 'oracle', label: CATALOGS.oracle.label, connected: has('oracle'),
      shell: { name: 'OCI Cloud Shell', url: 'https://cloud.oracle.com/?cloudshell=true' },
      summary: 'Actual daily costs (Usage API) and your invoices with due dates (OSP Gateway).',
      steps: [
        'Run the command in OCI Cloud Shell as an administrator: it adds a policy letting the app\'s group read cost data and invoices.',
        'It assumes the group from the setup guide, "CloudGaming"; if yours has another name, change it in both statements.',
      ],
      cli: `oci iam policy create --compartment-id ${tenancy} --name cloudgaming-billing --description "Cost data and invoices for Gints Global Gaming Hub" --statements '["Allow group CloudGaming to read usage-report in tenancy","Allow group CloudGaming to read invoices in tenancy"]'`,
      consoleUrl: 'https://cloud.oracle.com/identity/domains/policies', consoleLabel: 'Open Policies',
    },
  ];
}
