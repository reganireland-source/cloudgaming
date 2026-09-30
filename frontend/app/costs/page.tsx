'use client';

/**
 * ============================================================================
 * app/costs/page.tsx — WHAT YOUR MACHINES HAVE COST (REAL, ESTIMATED)
 * ============================================================================
 *
 * Every number here comes from your own machines:
 *   - Running now / standing cost: live from your clouds (/api/inventory)
 *   - This month / projection:     /api/costs/forecast
 *   - Daily chart:                 /api/costs/daily — one bar per day,
 *                                  split into machine time and disk
 *   - By cloud:                    /api/costs/monthly
 *   - Standing costs (#standing):  /api/inventory/standing — everything
 *                                  billed while idle, with advice and
 *                                  Shelve / delete-snapshot actions
 * Costs are the app's hourly ESTIMATES (the hourly cost job records each
 * machine's price while running, and its disk while it exists), not your
 * cloud bill. Data streamed to you isn't included yet.
 *
 * Chart colours: orange = machine time, violet = disk. Deliberately NOT the
 * cloud colours (blue/amber/teal/pink), which mean "which cloud" everywhere
 * else in the app. Validated for colour-blind separation on this surface.
 * ============================================================================
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usd } from '@/lib/money';
import CloudLogo from '@/components/CloudLogo';
import StandingCosts from '@/components/StandingCosts';
import BillingReconciliation, { withAlso, type Reconciliation } from '@/components/BillingReconciliation';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { apiFetch } from '@/lib/auth';
import { useAuth } from '@/components/AuthProvider';
import ThemedSelect from '@/components/ThemedSelect';

interface Day { date: string; compute: string | number; egress: string | number; storage: string | number; total: string | number }
interface Forecast { totalSoFar: number; dailyAverage: number; projectedTotal: number; daysElapsed: number; daysInMonth: number }
interface Monthly { total: number; breakdown: Array<{ provider: string; compute: string; egress: string; storage: string }> }
interface Inventory { totals: { runningMachines: number; hourly: number; monthlyStanding: number; orphans: number; orphanMonthly: number } }

const SERIES = { compute: { label: 'Machine time (est.)', color: '#d95926' }, storage: { label: 'Disk (est.)', color: '#9085e9' } };
// What the clouds actually billed, converted to USD: a line over the estimate bars.
const BILLED = { label: 'Billed by your clouds', color: '#e2e8f0' };
const ALSO_KEY = 'costs.alsoIn';
const CLOUD: Record<string, { label: string; color: string }> = {
  gcp: { label: 'Google Cloud', color: '#3987e5' }, aws: { label: 'AWS', color: '#c98500' },
  azure: { label: 'Azure', color: '#199e70' }, oracle: { label: 'Oracle', color: '#d55181' },
};
const money = (n: number) => usd(n);
const n = (v: string | number) => Number(v) || 0;

export default function CostsPage() {
  const { user, loading: authLoading } = useAuth();
  const [days, setDays] = useState<Day[] | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [monthly, setMonthly] = useState<Monthly | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  // From the standing-costs section (live where clouds answer, estimated where they don't).
  const [standing, setStanding] = useState<number | null>(null);
  // What each cloud actually billed, reconciled with the estimates.
  const [recon, setRecon] = useState<Reconciliation | null>(null);
  const [reconBusy, setReconBusy] = useState(false);
  // Optional second currency for totals (estimates are USD).
  const [alsoIn, setAlsoIn] = useState('');
  useEffect(() => { try { setAlsoIn(localStorage.getItem(ALSO_KEY) || ''); } catch { /* ignore */ } }, []);
  const pickAlso = (c: string) => { setAlsoIn(c); try { localStorage.setItem(ALSO_KEY, c); } catch { /* ignore */ } };
  const loadRecon = useCallback((refresh = false) => {
    setReconBusy(true);
    apiFetch<Reconciliation>(`/costs/actuals${refresh ? '?refresh=true' : ''}`).then(setRecon).catch(() => setRecon(null)).finally(() => setReconBusy(false));
  }, []);

  const load = useCallback(() => {
    apiFetch<{ history: Day[] }>('/costs/daily?days=30').then((r) => setDays(r.history)).catch((e) => { setDays([]); setError(e?.message || 'Couldn’t load costs.'); });
    apiFetch<Forecast>('/costs/forecast').then(setForecast).catch(() => setForecast(null));
    apiFetch<Monthly>('/costs/monthly').then(setMonthly).catch(() => setMonthly(null));
    apiFetch<Inventory>('/inventory').then(setInventory).catch(() => setInventory(null));
    loadRecon();
  }, [loadRecon]);

  useEffect(() => { if (user) load(); }, [user, load]);

  if (authLoading) return <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; LOADING…</p>;
  if (!user) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold neon-text font-mono">[ COSTS ]</h1>
        <p className="text-sm text-slate-400"><Link href="/login?next=/costs" className="text-neon-cyan hover:underline">Sign in</Link> to see what your machines cost.</p>
      </div>
    );
  }

  const t = inventory?.totals;
  // Billed (USD) per day, summed over the clouds that have reported that day.
  const billedByDay = new Map<string, number>();
  for (const c of recon?.clouds || []) for (const d of c.daily) {
    if (d.actualUsd != null) billedByDay.set(d.date, (billedByDay.get(d.date) || 0) + d.actualUsd);
  }
  const chart = (days || []).map((d) => {
    const key = String(d.date).slice(0, 10);
    return {
      day: new Date(d.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      compute: Math.round(n(d.compute) * 100) / 100,
      storage: Math.round(n(d.storage) * 100) / 100,
      total: n(d.total),
      billed: billedByDay.has(key) ? Math.round(billedByDay.get(key)! * 100) / 100 : null,
    };
  });
  const hasBilled = chart.some((c) => c.billed != null);
  const fc = recon?.forecast;
  const currencies = Object.keys(recon?.fx?.rates || {}).filter((c) => c !== 'USD');
  const byCloud = (monthly?.breakdown || []).map((b) => ({
    provider: b.provider, compute: n(b.compute), storage: n(b.storage), egress: n(b.egress),
    total: n(b.compute) + n(b.storage) + n(b.egress),
  })).sort((a, b) => b.total - a.total);
  const empty = days !== null && chart.length === 0;

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold neon-text mb-1 font-mono">[ COSTS ]</h1>
          <p className="text-sm text-slate-400 max-w-2xl short:hidden">What your machines cost: the app&apos;s hourly estimates (USD), reconciled with what each cloud actually billed (in your billing currency).</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {currencies.length > 0 && (
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-400">Also show in
              <ThemedSelect compact align="right" value={alsoIn} onChange={pickAlso} ariaLabel="Also show in" className="min-w-[8rem] text-xs"
                options={[{ value: '', label: '— (USD only)' }, ...currencies.map((c) => ({ value: c, label: c }))]} />
            </label>
          )}
          <button type="button" onClick={() => { load(); loadRecon(true); }} disabled={reconBusy} className="btn-neon text-xs">{reconBusy ? 'Checking bills…' : '↻ Refresh'}</button>
        </div>
      </div>

      {error && <p className="text-sm text-neon-amber">⚠ {error}</p>}

      {/* ---- Headline numbers ---- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        {fc ? (
          <>
            <Tile label="This month so far" value={withAlso(fc.soFarUsd, alsoIn, recon?.fx?.rates)}
              sub={fc.basis === 'estimate' ? `estimated · ${fc.daysElapsed} of ${fc.daysInMonth} days` : `${usd(fc.fromActualsUsd)} billed + ${usd(fc.fromEstimatesUsd)} estimated (not billed yet)`} />
            <Tile label="Month projection" value={withAlso(fc.projectedUsd, alsoIn, recon?.fx?.rates)}
              sub={`at ${usd(fc.dailyRateUsd)}/day · ${fc.basis === 'estimate' ? 'from estimates' : fc.basis === 'actual' ? 'from your bills' : 'from bills where reported, estimates otherwise'}`} />
          </>
        ) : (
          <>
            <Tile label="This month so far" value={forecast ? money(forecast.totalSoFar) : '—'} sub={forecast ? `estimated · ${forecast.daysElapsed} of ${forecast.daysInMonth} days` : 'estimated'} />
            <Tile label="Month projection" value={forecast ? money(forecast.projectedTotal) : '—'} sub={forecast ? `at ${money(forecast.dailyAverage)}/day (estimated)` : 'at this month’s pace'} />
          </>
        )}
        <Tile label="Running now" value={t ? `${money(t.hourly)}/h` : '—'} sub={t ? `${t.runningMachines} machine${t.runningMachines === 1 ? '' : 's'} running` : 'live from your clouds'} />
        <a href="#standing" className="block hover:opacity-90"><Tile label="Standing cost" value={standing != null ? `${money(standing)}/mo` : t ? `${money(t.monthlyStanding)}/mo` : '—'} sub="disks, snapshots, IPs — billed even when stopped · see below ↓" /></a>
      </div>
      {t && t.orphans > 0 && (
        <p className="text-xs text-neon-pink">⚠ {t.orphans} leftover resource{t.orphans === 1 ? '' : 's'} costing ≈{money(t.orphanMonthly)}/mo — see the <Link href="/map" className="underline">Map</Link>.</p>
      )}

      {/* ---- What the clouds actually billed vs the estimates ---- */}
      {recon && <BillingReconciliation data={recon} alsoIn={alsoIn} onChanged={() => loadRecon(true)} />}

      {/* ---- Standing costs: the money spent while not playing ---- */}
      <StandingCosts onTotal={setStanding} />

      {/* ---- Daily spend (single measure, stacked by what it's for) ---- */}
      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3 sm:p-4 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm text-slate-200">Daily spend · last 30 days <span className="text-slate-500 text-xs">(USD)</span></h2>
          <div className="flex flex-wrap gap-3 text-xs text-slate-300" aria-label="Legend">
            {Object.values(SERIES).map((s) => (
              <span key={s.label} className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span>
            ))}
            {hasBilled && <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-0.5 w-4 rounded" style={{ background: BILLED.color }} />{BILLED.label}</span>}
          </div>
        </div>
        {days === null ? (
          <p className="text-xs text-slate-500 py-10 text-center">Loading…</p>
        ) : empty ? (
          <p className="text-xs text-slate-500 py-10 text-center">No costs recorded yet — the first appear within an hour of a machine running.</p>
        ) : (
          <div className="h-56 sm:h-64 -ml-2">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="day" tick={{ fill: '#a9b5c4', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.12)' }} minTickGap={12} />
                <YAxis tick={{ fill: '#a9b5c4', fontSize: 11 }} tickLine={false} axisLine={false} width={36} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                  contentStyle={{ background: '#0c1018', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: '#e2e8f0' }} itemStyle={{ color: '#cbd5e1' }}
                  formatter={(value: number, name: string) => [money(value), name]}
                />
                {/* 2px surface-coloured stroke = the gap between stacked segments */}
                <Bar dataKey="storage" name={SERIES.storage.label} stackId="c" fill={SERIES.storage.color} stroke="#0c1018" strokeWidth={2} radius={[4, 4, 0, 0]} />
                <Bar dataKey="compute" name={SERIES.compute.label} stackId="c" fill={SERIES.compute.color} stroke="#0c1018" strokeWidth={2} radius={[4, 4, 0, 0]} />
                {hasBilled && <Line dataKey="billed" name={`${BILLED.label} (USD)`} type="linear" stroke={BILLED.color} strokeWidth={2} dot={{ r: 3, strokeWidth: 0, fill: BILLED.color }} connectNulls={false} />}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        {!empty && days && (
          <details>
            <summary className="text-xs text-slate-400 cursor-pointer">Show as a table</summary>
            <div className="mt-2 max-h-64 overflow-auto">
              <table className="w-full text-xs tabular-nums">
                <thead><tr className="text-left text-slate-500"><th className="py-1 pr-3 font-normal">Day</th><th className="py-1 pr-3 font-normal text-right">Machine time</th><th className="py-1 pr-3 font-normal text-right">Disk</th><th className="py-1 pr-3 font-normal text-right">Total (est.)</th><th className="py-1 font-normal text-right">Billed</th></tr></thead>
                <tbody className="text-slate-300">
                  {[...chart].reverse().map((d) => (
                    <tr key={d.day} className="border-t border-white/5"><td className="py-1 pr-3">{d.day}</td><td className="py-1 pr-3 text-right">{money(d.compute)}</td><td className="py-1 pr-3 text-right">{money(d.storage)}</td><td className="py-1 pr-3 text-right text-slate-100">{money(d.total)}</td><td className="py-1 text-right text-slate-300">{d.billed != null ? money(d.billed) : '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </section>

      {/* ---- This month by cloud ---- */}
      <section className="space-y-2">
        <h2 className="label">This month by cloud</h2>
        {byCloud.length === 0 ? (
          <p className="text-xs text-slate-500">Nothing recorded this month yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {byCloud.map((c) => {
              const cl = CLOUD[c.provider] || { label: c.provider, color: '#94a3b8' };
              return (
                <li key={c.provider} className="flex items-center gap-3 rounded border border-white/10 px-3 py-2 text-sm">
                  <CloudLogo provider={c.provider} size={18} />
                  <span className="text-slate-200 flex-1 min-w-0 truncate">{cl.label}</span>
                  <span className="text-xs text-slate-500 tabular-nums hidden xs:inline">{money(c.compute)} machine · {money(c.storage)} disk</span>
                  <span className="text-slate-100 tabular-nums">{money(c.total)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="text-[0.72rem] text-slate-500">
        Estimates from each machine’s hourly price (live spot price where the cloud publishes one) and its disk size; recorded every hour. Data streamed to you (egress, roughly USD 0.10/GB on most clouds) isn’t counted yet. For exact figures, see your cloud’s billing page.
      </p>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded border border-white/10 bg-white/[0.02] px-3 py-2.5">
      <p className="label">{label}</p>
      <p className="text-lg text-slate-100 tabular-nums mt-0.5">{value}</p>
      <p className="text-[0.72rem] text-slate-500 mt-0.5 leading-snug">{sub}</p>
    </div>
  );
}
