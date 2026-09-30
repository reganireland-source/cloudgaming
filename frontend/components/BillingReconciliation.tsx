'use client';

/**
 * ============================================================================
 * components/BillingReconciliation.tsx — ESTIMATE vs WHAT THE CLOUD BILLED
 * ============================================================================
 *
 * One card per cloud (GET /api/costs/actuals):
 *   - what the cloud actually billed this month, in ITS billing currency
 *     (e.g. SGD), up to the last day it has reported (clouds lag 8-24 h),
 *     with the USD equivalent at the day's ECB rate;
 *   - the app's estimate for the same days (USD, list prices);
 *   - the difference, and why it can differ (scope, credits, taxes, lag);
 *   - or, when the cloud can't be read yet, exactly what to set up.
 * Google needs one setting (its BigQuery billing export table), entered here.
 * ============================================================================
 */

import { useState } from 'react';
import { apiFetch, type FriendlyError } from '@/lib/auth';
import { money, usd, fromUsd } from '@/lib/money';
import CloudLogo from '@/components/CloudLogo';

export interface CloudRecon {
  provider: string; label: string;
  status: 'ok' | 'needs-setup' | 'error' | 'not-connected';
  error?: FriendlyError;
  fetchedAt?: string;
  currency?: string; scope?: string; scopeNote?: string; notes?: string[];
  settings?: { exportTable?: string };
  dataThrough?: string;
  actual?: { amount: number; currency: string; usd: number | null };
  accountActual?: { amount: number; currency: string; usd: number | null };
  estimateSameDaysUsd: number;
  estimateMonthUsd: number;
  differenceUsd: number | null;
  differencePct: number | null;
  daily: Array<{ date: string; estimateUsd: number; actual: number | null; actualUsd: number | null }>;
}
export interface Reconciliation {
  generatedAt: string; month: string; estimateCurrency: 'USD';
  fx: { base: 'USD'; date: string; source: string; rates: Record<string, number> } | null;
  clouds: CloudRecon[];
  forecast: { currency: 'USD'; soFarUsd: number; fromActualsUsd: number; fromEstimatesUsd: number; dailyRateUsd: number; projectedUsd: number; daysElapsed: number; daysInMonth: number; basis: 'actual' | 'mixed' | 'estimate' };
}

const ago = (iso?: string) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 2 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const fmtDate = (d?: string) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');

/** "USD 12.30 (SGD 15.87)" when a second currency is chosen. */
export function withAlso(amountUsd: number, alsoIn: string, rates?: Record<string, number> | null) {
  if (!alsoIn || alsoIn === 'USD') return usd(amountUsd);
  const v = fromUsd(amountUsd, alsoIn, rates);
  return v === null ? usd(amountUsd) : `${usd(amountUsd)} (${money(v, alsoIn)})`;
}

export default function BillingReconciliation({ data, alsoIn, onChanged }: { data: Reconciliation; alsoIn: string; onChanged: () => void }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm tracking-label font-bold neon-text font-mono">[ ESTIMATE_VS_BILLED ]</h2>
        <p className="text-xs text-slate-400 max-w-3xl mt-0.5">
          The app estimates costs every hour from list prices, in <strong className="text-slate-200">USD</strong>. Each cloud&apos;s own billing reports the real charges, in your account&apos;s
          <strong className="text-slate-200"> billing currency</strong>, 8–24 hours later. Here they are side by side for the same days.
        </p>
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {data.clouds.map((c) => <CloudCard key={c.provider} c={c} alsoIn={alsoIn} rates={data.fx?.rates} onChanged={onChanged} />)}
      </div>
      <p className="text-[0.72rem] text-slate-500 leading-relaxed">
        Why they can differ: the bill may include things the app doesn&apos;t price (taxes, data transfer, IP addresses, other resources in the account), credits and discounts, and
        a price that differs from the list price. {data.fx
          ? <>Conversions use the {data.fx.source.split(' (')[0]} rate of {data.fx.date} (1 USD = {Object.entries(data.fx.rates).filter(([k]) => k !== 'USD' && data.clouds.some((c) => c.currency === k)).map(([k, v]) => `${v} ${k}`).join(', ') || 'see picker'}).</>
          : <>Exchange rates are unavailable right now, so bills in other currencies are shown without a USD equivalent.</>}
      </p>
    </section>
  );
}

function CloudCard({ c, alsoIn, rates, onChanged }: { c: CloudRecon; alsoIn: string; rates?: Record<string, number> | null; onChanged: () => void }) {
  const tone = c.status === 'ok' ? 'border-white/10' : c.status === 'not-connected' ? 'border-white/5' : 'border-neon-amber/30';
  const diff = c.differenceUsd;
  return (
    <div className={`rounded-lg border ${tone} bg-white/[0.02] p-3 space-y-2 min-w-0`}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-sm text-slate-100"><CloudLogo provider={c.provider} size={18} />{c.label}</span>
        <span className="text-[0.66rem] uppercase tracking-label text-slate-500">
          {c.status === 'ok' ? (c.currency ? `billed in ${c.currency}` : 'connected') : c.status === 'not-connected' ? 'no keys' : c.status === 'needs-setup' ? 'needs setup' : 'couldn’t read'}
        </span>
      </div>

      {c.status === 'not-connected' ? (
        <p className="text-xs text-slate-500">Not connected. The app&apos;s estimate this month: {usd(c.estimateMonthUsd)}.</p>
      ) : c.status !== 'ok' ? (
        <SetupNeeded c={c} onChanged={onChanged} />
      ) : !c.actual ? (
        <p className="text-xs text-slate-400">Connected — no billed days reported yet this month (clouds report 8–24 h late). Estimate so far: {usd(c.estimateMonthUsd)}.</p>
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-2 text-xs">
            <div className="min-w-0">
              <dt className="text-[0.66rem] uppercase tracking-label text-slate-500">Billed</dt>
              <dd className="text-slate-100 tabular-nums">{money(c.actual.amount, c.actual.currency)}</dd>
              {c.actual.currency !== 'USD' && <dd className="text-[0.7rem] text-slate-500 tabular-nums">{c.actual.usd != null ? `≈ ${usd(c.actual.usd)}` : 'no rate'}</dd>}
            </div>
            <div className="min-w-0">
              <dt className="text-[0.66rem] uppercase tracking-label text-slate-500">App estimate</dt>
              <dd className="text-slate-300 tabular-nums">{usd(c.estimateSameDaysUsd)}</dd>
              <dd className="text-[0.7rem] text-slate-500">same days</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[0.66rem] uppercase tracking-label text-slate-500">Difference</dt>
              <dd className={`tabular-nums ${diff == null ? 'text-slate-500' : Math.abs(c.differencePct ?? 0) <= 10 ? 'text-neon-lime' : 'text-neon-amber'}`}>
                {diff == null ? '—' : `${diff >= 0 ? '+' : '−'}${usd(Math.abs(diff))}`}
              </dd>
              <dd className="text-[0.7rem] text-slate-500">{c.differencePct == null ? '' : `${c.differencePct >= 0 ? '+' : ''}${c.differencePct}% vs estimate`}</dd>
            </div>
          </dl>
          {alsoIn && alsoIn !== 'USD' && alsoIn !== c.actual.currency && c.actual.usd != null && (
            <p className="text-[0.7rem] text-slate-500">Billed ≈ {money(fromUsd(c.actual.usd, alsoIn, rates) ?? 0, alsoIn)}</p>
          )}
          <p className="text-[0.72rem] text-slate-500 leading-snug">
            {c.scopeNote} · 1 {fmtDate(c.daily[0]?.date)} – {fmtDate(c.dataThrough)} (the cloud has reported up to here) · checked {ago(c.fetchedAt)}
            {c.accountActual && c.scope !== 'account' && <> · whole account: {money(c.accountActual.amount, c.accountActual.currency)}</>}
          </p>
          {c.scope === 'account' && <p className="text-[0.72rem] text-neon-amber">Billed covers the whole account, so it includes anything else you run there.</p>}
          {(c.notes || []).map((n, i) => <p key={i} className="text-[0.72rem] text-slate-400">ℹ {n}</p>)}
        </>
      )}
    </div>
  );
}

function SetupNeeded({ c, onChanged }: { c: CloudRecon; onChanged: () => void }) {
  const [table, setTable] = useState(c.settings?.exportTable || '');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try { await apiFetch(`/costs/billing-settings/${c.provider}`, { method: 'PUT', body: { exportTable: table } }); onChanged(); } finally { setSaving(false); }
  };
  return (
    <div className="space-y-1.5 text-xs">
      <p className="text-neon-amber">{c.error?.title || 'Can’t read this cloud’s bill yet'}</p>
      {c.error?.explanation && <p className="text-slate-400">{c.error.explanation}</p>}
      {!!c.error?.fixes?.length && (
        <ol className="list-decimal pl-4 space-y-0.5 text-slate-300">
          {c.error.fixes.map((f, i) => <li key={i} className={/^[{a-z]+ |^\{|^az |^gcloud |^Allow /.test(f) ? 'font-mono text-[0.7rem] break-all' : ''}>{f}</li>)}
        </ol>
      )}
      {c.error?.consoleUrl && <a href={c.error.consoleUrl} target="_blank" rel="noreferrer" className="inline-block text-neon-cyan hover:underline">{c.error.consoleLabel || 'Open the console'} ↗</a>}
      {c.provider === 'gcp' && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <input value={table} onChange={(e) => setTable(e.target.value)} placeholder="project.dataset.gcp_billing_export_v1_…"
            className="input-neon flex-1 min-w-0 px-2 py-1 text-xs font-mono" aria-label="BigQuery billing export table" />
          <button type="button" onClick={save} disabled={saving || !table.trim()} className="btn-neon text-xs disabled:opacity-40">{saving ? 'Saving…' : 'Save & check'}</button>
        </div>
      )}
      <p className="text-slate-500">Until then, this cloud shows the app&apos;s estimate: {usd(c.estimateMonthUsd)} this month.</p>
    </div>
  );
}
