'use client';

/**
 * ============================================================================
 * app/quotas/page.tsx — QUOTA REQUEST STATUS, ONE CLOUD AT A TIME
 * ============================================================================
 *
 * The bulk view of the Regions page: pick a cloud and see every region at
 * once as one table — each tier × mode (normal / spot / big screen /
 * big screen + spot) as ✓ can launch, ✗ no quota, ⏳ request waiting, ◐ quota
 * in use by your machines, — not offered. Below it, every quota increase
 * request on that cloud with its outcome (open / approved / partly granted /
 * denied), filterable.
 *
 * Data: the same region check as Regions (cached 10 min; ↻ asks again) plus
 * GET /api/regions/quota-requests for the request history.
 * ============================================================================
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import CloudLogo from '@/components/CloudLogo';
import { useAuth } from '@/components/AuthProvider';
import {
  ACCESS_STYLE, RUN_MODES, fetchQuotaRequests, runRegionCheck,
  type AccessReport, type QuotaRequestHistory, type RegionAccess, type RequestState, type RunCell, type RunMode,
} from '@/lib/regionAccess';

const CLOUDS = [
  { id: 'gcp', short: 'Google' }, { id: 'aws', short: 'AWS' }, { id: 'azure', short: 'Azure' }, { id: 'oracle', short: 'Oracle' },
];
const TIER_ORDER = ['Good', 'Better', 'Best', 'Super'];
const MODE_SHORT: Record<RunMode, string> = { normal: 'N', spot: 'S', big: 'B', bigSpot: 'B+S' };

type Mark = 'yes' | 'no' | 'wait' | 'inuse' | 'unknown' | 'na';
const MARK: Record<Mark, { icon: string; label: string; cls: string }> = {
  yes: { icon: '✓', label: 'Can launch', cls: 'text-neon-lime bg-neon-lime/[0.08]' },
  no: { icon: '✗', label: 'No quota', cls: 'text-neon-amber bg-neon-amber/[0.06]' },
  wait: { icon: '⏳', label: 'Request waiting', cls: 'text-neon-cyan bg-neon-cyan/[0.08]' },
  inuse: { icon: '◐', label: 'Quota in use by your machines', cls: 'text-neon-amber' },
  unknown: { icon: '?', label: 'Couldn’t tell', cls: 'text-slate-300' },
  na: { icon: '—', label: 'Not offered', cls: 'text-slate-600' },
};
const STATE: Record<RequestState, { label: string; cls: string }> = {
  open: { label: '⏳ Open', cls: 'text-neon-cyan' },
  approved: { label: '✓ Approved', cls: 'text-neon-lime' },
  partial: { label: '◑ Partly granted', cls: 'text-neon-amber' },
  denied: { label: '✗ Denied', cls: 'text-neon-pink' },
  cancelled: { label: '– Cancelled', cls: 'text-slate-500' },
};

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
}
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/** One grid cell: can launch, or why not (a waiting request beats "no quota"). */
function markOf(r: RegionAccess, cell?: RunCell): Mark {
  if (!cell || cell.na) return 'na';
  if (cell.ok === true) return 'yes';
  const waiting = (cell.uses || []).some((k) => r.quotaDetail?.find((q) => q.key === k)?.pending?.length);
  if (waiting) return 'wait';
  if (cell.ok === null) return 'unknown';
  return cell.inUse ? 'inuse' : 'no';
}

export default function QuotasPage() {
  const { user, loading: authLoading } = useAuth();
  const [provider, setProvider] = useState('gcp');
  const [report, setReport] = useState<AccessReport | null>(null);
  const [history, setHistory] = useState<Record<string, QuotaRequestHistory | { error: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | RequestState>('all');
  const [hideEmpty, setHideEmpty] = useState(true);
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem('recon.place') || 'null');
      if (p) setMe({ lat: p.lat, lng: p.lng });
      const c = localStorage.getItem('quotas.cloud');
      if (c && CLOUDS.some((x) => x.id === c)) setProvider(c);
    } catch { /* ignore */ }
  }, []);
  const pick = (c: string) => { setProvider(c); try { localStorage.setItem('quotas.cloud', c); } catch { /* ignore */ } };

  const loadHistory = useCallback(async (c: string) => {
    try { const h = await fetchQuotaRequests(c); setHistory((x) => ({ ...x, [c]: h })); }
    catch (e: any) { setHistory((x) => ({ ...x, [c]: { error: e?.message || 'Couldn’t read requests.' } })); }
  }, []);
  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    try {
      const [r] = await Promise.all([runRegionCheck(refresh, () => undefined), loadHistory(provider)]);
      setReport(r); setError(null);
    } catch (e: any) { setError(e?.message || 'Couldn’t check your clouds.'); }
    finally { setBusy(false); }
  }, [provider, loadHistory]);
  useEffect(() => { if (user && !report) load(false); }, [user, report, load]);
  useEffect(() => { if (user && report && !history[provider]) loadHistory(provider); }, [user, report, provider, history, loadHistory]);

  const cloud = report?.clouds.find((c) => c.provider === provider);
  const hist = history[provider];

  // Columns: the tiers this cloud has at all, × the four modes.
  const tiers = useMemo(() => {
    const has = new Set<string>();
    for (const r of cloud?.regions || []) for (const row of r.run || []) if (RUN_MODES.some((m) => !row.cells[m.id].na)) has.add(row.label);
    return TIER_ORDER.filter((t) => has.has(t));
  }, [cloud]);
  const rows = useMemo(() => {
    let list = [...(cloud?.regions || [])];
    if (hideEmpty) list = list.filter((r) => r.status !== 'not-offered');
    return me ? list.sort((a, b) => km(me, a) - km(me, b)) : list.sort((a, b) => a.name.localeCompare(b.name));
  }, [cloud, me, hideEmpty]);
  const totals = useMemo(() => {
    const t: Record<Mark, number> = { yes: 0, no: 0, wait: 0, inuse: 0, unknown: 0, na: 0 };
    for (const r of rows) for (const row of r.run || []) for (const m of RUN_MODES) t[markOf(r, row.cells[m.id])]++;
    return t;
  }, [rows]);

  const requests = useMemo(() => {
    if (!hist || 'error' in hist) return [];
    return [...hist.requests].sort((a, b) => String(b.updated || b.created || '').localeCompare(String(a.updated || a.created || '')));
  }, [hist]);
  const counts = useMemo(() => {
    const c: Record<RequestState, number> = { open: 0, approved: 0, partial: 0, denied: 0, cancelled: 0 };
    for (const q of requests) c[q.state]++;
    return c;
  }, [requests]);
  const regionName = (id: string) => (id ? cloud?.regions.find((r) => r.region === id)?.name || id : 'Project-wide');

  if (authLoading) return <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; LOADING…</p>;
  if (!user) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold neon-text font-mono">[ QUOTAS ]</h1>
        <p className="text-sm text-slate-400"><Link href="/login?next=/quotas" className="text-neon-cyan hover:underline">Sign in</Link> to see your quota and requests.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold neon-text mb-1 font-mono">[ QUOTA REQUEST STATUS ]</h1>
          <p className="text-sm text-slate-400 max-w-2xl">Every region of one cloud at a glance: what you can launch, what’s waiting on the cloud, and every quota request you’ve made with its outcome.</p>
        </div>
        <button type="button" onClick={() => load(true)} disabled={busy} className="btn-neon text-xs">{busy ? 'Checking…' : '↻ Re-check'}</button>
      </div>

      <div role="tablist" aria-label="Cloud" className="inline-flex rounded border border-white/10 overflow-hidden">
        {CLOUDS.map((c) => (
          <button key={c.id} type="button" role="tab" aria-selected={provider === c.id} onClick={() => pick(c.id)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border-l first:border-l-0 border-white/10 ${provider === c.id ? 'bg-neon-cyan/10 text-neon-cyan' : 'text-slate-400 hover:text-slate-200'}`}>
            <CloudLogo provider={c.id} size={16} />{c.short}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-neon-amber">⚠ {error}</p>}
      {!report ? (
        <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; CHECKING_REGIONS…</p>
      ) : !cloud?.connected ? (
        <p className="text-sm text-slate-400">{cloud?.label || provider} isn’t connected. <Link href="/settings" className="text-neon-cyan hover:underline">Add its keys on Config</Link>.</p>
      ) : cloud.error ? (
        <p className="text-sm text-neon-amber">Couldn’t check {cloud.label}: {cloud.error.title}</p>
      ) : (
        <>
          {/* ---- Legend + totals ---- */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.72rem] text-slate-400">
            {(['yes', 'wait', 'no', 'inuse', 'unknown', 'na'] as Mark[]).map((m) => (
              <span key={m} className="inline-flex items-center gap-1">
                <span className={`inline-block w-5 text-center rounded ${MARK[m].cls}`}>{MARK[m].icon}</span>{MARK[m].label}
                {m !== 'na' && <span className="tabular-nums text-slate-500">({totals[m]})</span>}
              </span>
            ))}
            <label className="inline-flex items-center gap-1 cursor-pointer ml-auto">
              <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />Hide regions that sell none of our GPUs
            </label>
          </div>

          {/* ---- The giant table ---- */}
          <div className="rounded-lg border border-white/10 overflow-x-auto">
            <table className="text-xs tabular-nums border-collapse min-w-full">
              <thead>
                <tr className="bg-white/[0.03] text-[0.68rem] uppercase tracking-label text-slate-500">
                  <th rowSpan={2} className="sticky left-0 z-10 bg-cyber-dark text-left font-normal py-1.5 pl-2.5 pr-3 min-w-[9rem]">Region {me ? '(nearest first)' : ''}</th>
                  {tiers.map((t) => <th key={t} colSpan={RUN_MODES.length} className="font-normal py-1 px-1 border-l border-white/10 text-slate-300">{t}</th>)}
                  <th rowSpan={2} className="font-normal py-1.5 px-2 border-l border-white/10 text-left">Open requests</th>
                </tr>
                <tr className="bg-white/[0.03] text-[0.64rem] text-slate-500">
                  {tiers.map((t) => RUN_MODES.map((m, i) => (
                    <th key={`${t}-${m.id}`} title={m.label} className={`font-normal py-1 px-1 w-9 ${i === 0 ? 'border-l border-white/10' : ''}`}>{MODE_SHORT[m.id]}</th>
                  )))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pend = (r.quotaDetail || []).filter((q) => q.pending?.length);
                  const whole = !r.run?.length;
                  return (
                    <tr key={r.region} className="border-t border-white/5 hover:bg-white/[0.02]">
                      <td className="sticky left-0 z-10 bg-cyber-dark py-1 pl-2.5 pr-3">
                        <span className="block text-slate-100 leading-tight">{r.name}</span>
                        <span className="block text-[0.64rem] text-slate-500">{r.region}</span>
                      </td>
                      {whole ? (
                        <td colSpan={tiers.length * RUN_MODES.length} className="px-2 text-[0.7rem] border-l border-white/10">
                          <span className={`inline-block rounded border px-1.5 ${ACCESS_STYLE[r.status].className}`}>{ACCESS_STYLE[r.status].icon} {ACCESS_STYLE[r.status].label}</span>
                          <span className="ml-2 text-slate-500">{r.summary}</span>
                        </td>
                      ) : tiers.map((t) => {
                        const row = r.run!.find((x) => x.label === t);
                        return (
                          <Fragment key={t}>
                            {RUN_MODES.map((m, i) => {
                              const cell = row?.cells[m.id];
                              const mk = markOf(r, cell);
                              return (
                                <td key={m.id} title={`${t} · ${m.label}: ${cell?.why || 'not offered'}`}
                                  className={`text-center py-1 px-1 ${i === 0 ? 'border-l border-white/10' : ''} ${MARK[mk].cls}`}>
                                  {MARK[mk].icon}
                                </td>
                              );
                            })}
                          </Fragment>
                        );
                      })}
                      <td className="px-2 py-1 border-l border-white/10 text-[0.68rem] text-neon-cyan whitespace-nowrap">
                        {pend.map((q) => `${q.label.replace(/ \(.*\)$/, '')} → ${q.pending![0].requested}`).join(' · ')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[0.7rem] text-slate-500">
            N = normal · S = spot · B = big screen · B+S = big screen on spot. Hover a cell for the reason. Checked {new Date(cloud.checkedAt).toLocaleTimeString()} (kept 10 minutes; ↻ asks again).
            Need lots of quota? The <Link href="/regions" className="text-neon-cyan hover:underline">Regions</Link> page has a mega bulk command.
          </p>

          {/* ---- Every request ---- */}
          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="text-sm font-semibold text-slate-200">All quota requests on {cloud.label}</h2>
              <div role="radiogroup" aria-label="Filter requests" className="inline-flex rounded border border-white/10 overflow-hidden text-xs">
                {(['all', 'open', 'approved', 'partial', 'denied', 'cancelled'] as const).map((f) => (
                  <button key={f} type="button" role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}
                    className={`px-2.5 py-1 border-l first:border-l-0 border-white/10 ${filter === f ? 'bg-neon-cyan/10 text-neon-cyan' : 'text-slate-400 hover:text-slate-200'}`}>
                    {f === 'all' ? `All (${requests.length})` : `${STATE[f].label.replace(/^\S+ /, '')} (${counts[f]})`}
                  </button>
                ))}
              </div>
            </div>
            {!hist ? (
              <p className="text-xs text-slate-500 animate-pulse">Reading requests…</p>
            ) : 'error' in hist ? (
              <p className="text-xs text-neon-amber">⚠ {hist.error}</p>
            ) : (
              <>
                {hist.note && <p className="text-[0.7rem] text-slate-500">{hist.note}</p>}
                {requests.length === 0 ? (
                  hist.readable && <p className="text-xs text-slate-400">No quota requests on {cloud.label} yet.</p>
                ) : (
                  <div className="rounded-lg border border-white/10 overflow-x-auto">
                    <table className="w-full text-xs tabular-nums">
                      <thead className="bg-white/[0.03] text-[0.66rem] uppercase tracking-label text-slate-500 text-left">
                        <tr>
                          <th className="font-normal py-1.5 pl-2.5 pr-2">Region</th><th className="font-normal py-1.5 px-2">Quota</th>
                          <th className="font-normal py-1.5 px-2 text-right">Asked</th>
                          {provider === 'gcp' && <th className="font-normal py-1.5 px-2 text-right">Granted</th>}
                          <th className="font-normal py-1.5 px-2">Outcome</th><th className="font-normal py-1.5 px-2">Cloud says</th>
                          <th className="font-normal py-1.5 px-2">Asked on</th><th className="font-normal py-1.5 px-2">Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {requests.filter((q) => filter === 'all' || q.state === filter).map((q, i) => (
                          <tr key={`${q.id}-${q.region}-${q.key}-${i}`} className="border-t border-white/5">
                            <td className="py-1 pl-2.5 pr-2 whitespace-nowrap"><span className="text-slate-200">{regionName(q.region)}</span>{q.region && <span className="text-slate-500"> · {q.region}</span>}</td>
                            <td className="py-1 px-2 text-slate-300">{q.label}</td>
                            <td className="py-1 px-2 text-right text-slate-100">{q.requested}</td>
                            {provider === 'gcp' && <td className="py-1 px-2 text-right">{q.granted ?? '—'}</td>}
                            <td className={`py-1 px-2 whitespace-nowrap ${STATE[q.state].cls}`}>{STATE[q.state].label}</td>
                            <td className="py-1 px-2 text-slate-500 max-w-[22rem]">{q.status}</td>
                            <td className="py-1 px-2 whitespace-nowrap text-slate-400">{day(q.created)}</td>
                            <td className="py-1 px-2 whitespace-nowrap text-slate-400">{day(q.updated)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {provider === 'gcp' && <p className="text-[0.7rem] text-slate-500">Google keeps one request per quota and region (changing it replaces the old one), and doesn’t always mark a refusal in the API — Google’s email has the final word.</p>}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
