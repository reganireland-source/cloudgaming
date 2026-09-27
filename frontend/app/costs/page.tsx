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
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { apiFetch } from '@/lib/auth';
import { useAuth } from '@/components/AuthProvider';

interface Day { date: string; compute: string | number; egress: string | number; storage: string | number; total: string | number }
interface Forecast { totalSoFar: number; dailyAverage: number; projectedTotal: number; daysElapsed: number; daysInMonth: number }
interface Monthly { total: number; breakdown: Array<{ provider: string; compute: string; egress: string; storage: string }> }
interface Inventory { totals: { runningMachines: number; hourly: number; monthlyStanding: number; orphans: number; orphanMonthly: number } }

const SERIES = { compute: { label: 'Machine time', color: '#d95926' }, storage: { label: 'Disk', color: '#9085e9' } };
const CLOUD: Record<string, { label: string; color: string }> = {
  gcp: { label: 'Google Cloud', color: '#3987e5' }, aws: { label: 'AWS', color: '#c98500' },
  azure: { label: 'Azure', color: '#199e70' }, oracle: { label: 'Oracle', color: '#d55181' },
};
const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`;
const n = (v: string | number) => Number(v) || 0;

export default function CostsPage() {
  const { user, loading: authLoading } = useAuth();
  const [days, setDays] = useState<Day[] | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [monthly, setMonthly] = useState<Monthly | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch<{ history: Day[] }>('/costs/daily?days=30').then((r) => setDays(r.history)).catch((e) => { setDays([]); setError(e?.message || 'Couldn’t load costs.'); });
    apiFetch<Forecast>('/costs/forecast').then(setForecast).catch(() => setForecast(null));
    apiFetch<Monthly>('/costs/monthly').then(setMonthly).catch(() => setMonthly(null));
    apiFetch<Inventory>('/inventory').then(setInventory).catch(() => setInventory(null));
  }, []);

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
  const chart = (days || []).map((d) => ({
    day: new Date(d.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    compute: Math.round(n(d.compute) * 100) / 100,
    storage: Math.round(n(d.storage) * 100) / 100,
    total: n(d.total),
  }));
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
          <p className="text-sm text-slate-400 max-w-2xl short:hidden">What your machines have cost, from hourly estimates. Your cloud’s own billing page is the final word.</p>
        </div>
        <button type="button" onClick={load} className="btn-neon text-xs">↻ Refresh</button>
      </div>

      {error && <p className="text-sm text-neon-amber">⚠ {error}</p>}

      {/* ---- Headline numbers ---- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <Tile label="This month so far" value={forecast ? money(forecast.totalSoFar) : '—'} sub={forecast ? `${forecast.daysElapsed} of ${forecast.daysInMonth} days` : 'estimated'} />
        <Tile label="Month projection" value={forecast ? money(forecast.projectedTotal) : '—'} sub={forecast ? `at ${money(forecast.dailyAverage)}/day so far` : 'at this month’s pace'} />
        <Tile label="Running now" value={t ? `${money(t.hourly)}/h` : '—'} sub={t ? `${t.runningMachines} machine${t.runningMachines === 1 ? '' : 's'} running` : 'live from your clouds'} />
        <Tile label="Standing cost" value={t ? `${money(t.monthlyStanding)}/mo` : '—'} sub="disks, snapshots, IPs — billed even when stopped" />
      </div>
      {t && t.orphans > 0 && (
        <p className="text-xs text-neon-pink">⚠ {t.orphans} leftover resource{t.orphans === 1 ? '' : 's'} costing ≈{money(t.orphanMonthly)}/mo — see the <Link href="/map" className="underline">Map</Link>.</p>
      )}

      {/* ---- Daily spend (single measure, stacked by what it's for) ---- */}
      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3 sm:p-4 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm text-slate-200">Daily spend · last 30 days</h2>
          <div className="flex gap-3 text-xs text-slate-300" aria-label="Legend">
            {Object.values(SERIES).map((s) => (
              <span key={s.label} className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span>
            ))}
          </div>
        </div>
        {days === null ? (
          <p className="text-xs text-slate-500 py-10 text-center">Loading…</p>
        ) : empty ? (
          <p className="text-xs text-slate-500 py-10 text-center">No costs recorded yet — the first appear within an hour of a machine running.</p>
        ) : (
          <div className="h-56 sm:h-64 -ml-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="day" tick={{ fill: '#94a3b8', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.12)' }} minTickGap={12} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                  contentStyle={{ background: '#0c1018', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: '#e2e8f0' }} itemStyle={{ color: '#cbd5e1' }}
                  formatter={(value: number, name: string) => [money(value), name]}
                />
                {/* 2px surface-coloured stroke = the gap between stacked segments */}
                <Bar dataKey="storage" name={SERIES.storage.label} stackId="c" fill={SERIES.storage.color} stroke="#0c1018" strokeWidth={2} radius={[4, 4, 0, 0]} />
                <Bar dataKey="compute" name={SERIES.compute.label} stackId="c" fill={SERIES.compute.color} stroke="#0c1018" strokeWidth={2} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        {!empty && days && (
          <details>
            <summary className="text-xs text-slate-400 cursor-pointer">Show as a table</summary>
            <div className="mt-2 max-h-64 overflow-auto">
              <table className="w-full text-xs tabular-nums">
                <thead><tr className="text-left text-slate-500"><th className="py-1 pr-3 font-normal">Day</th><th className="py-1 pr-3 font-normal text-right">Machine time</th><th className="py-1 pr-3 font-normal text-right">Disk</th><th className="py-1 font-normal text-right">Total</th></tr></thead>
                <tbody className="text-slate-300">
                  {[...chart].reverse().map((d) => (
                    <tr key={d.day} className="border-t border-white/5"><td className="py-1 pr-3">{d.day}</td><td className="py-1 pr-3 text-right">{money(d.compute)}</td><td className="py-1 pr-3 text-right">{money(d.storage)}</td><td className="py-1 text-right text-slate-100">{money(d.total)}</td></tr>
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
                  <span aria-hidden className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: cl.color }} />
                  <span className="text-slate-200 flex-1 min-w-0 truncate">{cl.label}</span>
                  <span className="text-xs text-slate-500 tabular-nums hidden xs:inline">{money(c.compute)} machine · {money(c.storage)} disk</span>
                  <span className="text-slate-100 tabular-nums">{money(c.total)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="text-[0.68rem] text-slate-500">
        Estimates from each machine’s hourly price (live spot price where the cloud publishes one) and its disk size; recorded every hour. Data streamed to you (egress, roughly $0.1/GB on most clouds) isn’t counted yet. For exact figures, see your cloud’s billing page.
      </p>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded border border-white/10 bg-white/[0.02] px-3 py-2.5">
      <p className="label">{label}</p>
      <p className="text-lg text-slate-100 tabular-nums mt-0.5">{value}</p>
      <p className="text-[0.68rem] text-slate-500 mt-0.5 leading-snug">{sub}</p>
    </div>
  );
}
