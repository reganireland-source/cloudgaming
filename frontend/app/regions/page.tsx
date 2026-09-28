'use client';

/**
 * ============================================================================
 * app/regions/page.tsx — YOUR CLOUD REGIONS & PERMISSIONS
 * ============================================================================
 *
 * One view of "where can I actually launch?" across every cloud. The backend
 * asks each connected cloud directly (quota and region APIs — the same thing
 * the CLI commands on Config do) and returns, for every region the app
 * supports: Ready / No GPU quota / Region not enabled / Couldn't check /
 * Cloud not connected, plus the exact fix (steps, console link, CLI).
 *
 * Layout: rows are places (nearby regions from different clouds grouped,
 * e.g. "Singapore" = GCP + AWS + Azure Southeast Asia + Oracle), columns are
 * the four clouds. Tap a cell for its detail. If you picked a place on
 * Recon, places are sorted by estimated ping from there.
 * ============================================================================
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import CloudLogo from '@/components/CloudLogo';
import { useAuth } from '@/components/AuthProvider';
import { ACCESS_STYLE, fetchRegionAccess, type AccessReport, type AccessStatus, type RegionAccess } from '@/lib/regionAccess';

const CLOUDS = [
  { id: 'gcp', short: 'GCP', color: '#3987e5' },
  { id: 'aws', short: 'AWS', color: '#c98500' },
  { id: 'azure', short: 'Azure', color: '#199e70' },
  { id: 'oracle', short: 'Oracle', color: '#d55181' },
];
// Best-first, for a cell holding several regions of one cloud.
const ORDER: AccessStatus[] = ['ready', 'no-quota', 'unknown', 'not-enabled', 'not-offered', 'not-connected'];
const CLUSTER_KM = 300;

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
}
const pingMs = (d: number) => Math.round(5 + d * 0.015); // same estimate as Recon and the map
const area = (p: { lat: number; lng: number }) =>
  p.lng > 60 ? (p.lat < -10 ? 'Australia' : 'Asia') : p.lng < -30 ? 'Americas' : 'Europe';
const cityOf = (name: string) => name.replace(/\s*\(.*\)$/, '').replace(/^Ashburn$/, 'N. Virginia');

interface Cell { provider: string; regions: RegionAccess[] }
interface Place { key: string; label: string; area: string; lat: number; lng: number; cells: Record<string, Cell> }

/** Group nearby regions from all clouds into places. */
function buildPlaces(report: AccessReport): Place[] {
  const places: Place[] = [];
  for (const cloud of report.clouds) {
    for (const r of cloud.regions) {
      let p = places.find((x) => km(x, r) <= CLUSTER_KM);
      if (!p) { p = { key: r.region, label: cityOf(r.name), area: area(r), lat: r.lat, lng: r.lng, cells: {} }; places.push(p); }
      (p.cells[cloud.provider] ||= { provider: cloud.provider, regions: [] }).regions.push(r);
    }
  }
  return places;
}
const best = (c?: Cell): AccessStatus | null =>
  c ? [...c.regions].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))[0].status : null;

export default function RegionsPage() {
  const { user, loading: authLoading } = useAuth();
  const [report, setReport] = useState<AccessReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ place: string; provider: string } | null>(null);
  const [me, setMe] = useState<{ lat: number; lng: number; label: string } | null>(null);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try { setReport(await fetchRegionAccess(refresh)); setError(null); }
    catch (e: any) { setError(e?.message || 'Couldn’t check your clouds.'); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { if (user) load(); }, [user, load]);
  useEffect(() => {
    try { const s = localStorage.getItem('recon.place'); if (s) { const p = JSON.parse(s); setMe({ lat: p.lat, lng: p.lng, label: p.label }); } } catch { /* ignore */ }
  }, []);

  const places = useMemo(() => {
    if (!report) return [];
    const list = buildPlaces(report);
    return me ? list.sort((a, b) => km(me, a) - km(me, b)) : list.sort((a, b) => a.area.localeCompare(b.area) || a.label.localeCompare(b.label));
  }, [report, me]);

  if (authLoading) return <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; LOADING…</p>;
  if (!user) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold neon-text font-mono">[ REGIONS ]</h1>
        <p className="text-sm text-slate-400"><Link href="/login?next=/regions" className="text-neon-cyan hover:underline">Sign in</Link> to see where your clouds let you launch.</p>
      </div>
    );
  }

  const counts = (provider: string) => {
    const c = report?.clouds.find((x) => x.provider === provider);
    const n: Partial<Record<AccessStatus, number>> = {};
    for (const r of c?.regions || []) n[r.status] = (n[r.status] || 0) + 1;
    return { cloud: c, n };
  };
  const openCell = open && places.find((p) => p.key === open.place)?.cells[open.provider];

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold neon-text mb-1 font-mono">[ REGIONS ]</h1>
          <p className="text-sm text-slate-400 max-w-2xl short:hidden">Where each of your clouds will let you launch a GPU machine: quota, region switched on, keys connected. Checked live with each cloud; tap a cell for what to do.</p>
        </div>
        <button type="button" onClick={() => load(true)} disabled={busy} className="btn-neon text-xs">{busy ? 'Checking…' : '↻ Re-check'}</button>
      </div>

      {error && <p className="text-sm text-neon-amber">⚠ {error}</p>}

      {!report ? (
        <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; ASKING_YOUR_CLOUDS… (up to 30 s the first time)</p>
      ) : (
        <>
          {/* ---- Per-cloud summary ---- */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {CLOUDS.map((c) => {
              const { cloud, n } = counts(c.id);
              return (
                <div key={c.id} className="rounded border border-white/10 bg-white/[0.02] px-3 py-2 min-w-0">
                  <p className="flex items-center gap-1.5 text-sm text-slate-100"><CloudLogo provider={c.id} size={18} />{cloud?.label || c.short}</p>
                  {!cloud?.connected ? (
                    <p className="text-[0.7rem] text-slate-500 mt-0.5">Not connected · <Link href="/settings" className="text-neon-cyan hover:underline">add keys</Link></p>
                  ) : cloud.error ? (
                    <p className="text-[0.7rem] text-neon-amber mt-0.5">Couldn’t check: {cloud.error.title}</p>
                  ) : (
                    <p className="text-[0.7rem] text-slate-400 mt-0.5 tabular-nums">
                      <span className="text-neon-lime">{n.ready || 0} ready</span>
                      {n['no-quota'] ? <> · <span className="text-neon-amber">{n['no-quota']} no quota</span></> : null}
                      {n['not-enabled'] ? <> · <span className="text-neon-pink">{n['not-enabled']} off</span></> : null}
                      {n.unknown ? <> · {n.unknown} unchecked</> : null}
                      {n['not-offered'] ? <> · <span className="text-slate-500">{n['not-offered']} not sold</span></> : null}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* ---- Legend ---- */}
          <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:flex sm:flex-wrap text-[0.7rem] text-slate-400" aria-label="Legend">
            {(Object.keys(ACCESS_STYLE) as AccessStatus[]).map((s) => (
              <li key={s} className="inline-flex items-center gap-1"><Chip status={s} mode="icon" /> {ACCESS_STYLE[s].label}</li>
            ))}
            <li className="inline-flex items-center gap-1"><span className="inline-block w-6 text-center text-slate-600">·</span> Cloud has no region here</li>
            <li className="col-span-2 sm:hidden text-slate-500">Tap a symbol in the table for the details and the fix.</li>
          </ul>

          {/* ---- Places × clouds ---- */}
          <div className="rounded-lg border border-white/10 overflow-hidden">
            <table className="w-full text-sm table-fixed">
              <thead>
                <tr className="text-left text-[0.66rem] uppercase tracking-label text-slate-500 bg-white/[0.03]">
                  <th className="py-2 pl-2.5 pr-1 font-normal">{me ? <>Nearest to {me.label.split(',')[0]}</> : 'Place'}</th>
                  {CLOUDS.map((c) => <th key={c.id} className="py-2 px-0.5 font-normal text-center w-10 sm:w-28"><span className="inline-flex flex-col sm:flex-row items-center gap-1"><CloudLogo provider={c.id} size={18} /><span className="hidden sm:inline">{c.short}</span></span></th>)}
                </tr>
              </thead>
              <tbody>
                {places.map((p) => {
                  const isOpen = open?.place === p.key && openCell;
                  return (
                    <Fragment key={p.key}>
                      <tr className="border-t border-white/5">
                        <td className="py-1.5 pl-2.5 pr-1 min-w-0">
                          <p className="text-slate-100 truncate leading-tight">{p.label}</p>
                          <p className="text-[0.64rem] text-slate-500 tabular-nums">{me ? `~${pingMs(km(me, p))} ms` : p.area}</p>
                        </td>
                        {CLOUDS.map((c) => {
                          const cell = p.cells[c.id];
                          const st = best(cell);
                          const sel = open?.place === p.key && open.provider === c.id;
                          return (
                            <td key={c.id} className="py-1.5 px-0.5 text-center">
                              {st ? (
                                <button type="button" onClick={() => setOpen(sel ? null : { place: p.key, provider: c.id })}
                                  aria-expanded={sel} aria-label={`${c.short} ${p.label}: ${ACCESS_STYLE[st].label}`}
                                  className={`rounded ${sel ? 'ring-1 ring-neon-cyan' : ''}`}>
                                  <Chip status={st} />
                                </button>
                              ) : <span className="text-slate-600" title={`${c.short} has no region here`}>·</span>}
                            </td>
                          );
                        })}
                      </tr>
                      {isOpen && (
                        <tr className="bg-white/[0.02]">
                          <td colSpan={5} className="px-2.5 py-3">
                            <Detail cell={openCell!} cloudLabel={report.clouds.find((x) => x.provider === open!.provider)?.label || open!.provider} onClose={() => setOpen(null)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[0.68rem] text-slate-500">
            Checked {new Date(report.generatedAt).toLocaleTimeString()} (results are kept 10 minutes; Re-check asks again).
            Quota is what your account is <em>allowed</em>; a region can still be temporarily out of GPUs, which only shows up when you launch.
            New to quotas? The <Link href="/settings" className="text-neon-cyan hover:underline">Config</Link> page has step-by-step guides for each cloud.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Status chip. "icon" = the symbol only (legend); "auto" = symbol only on
 * phones, where four columns of words don't fit, and symbol + word from
 * 640px; "full" = always both (detail panel).
 */
function Chip({ status, mode = 'auto' }: { status: AccessStatus; mode?: 'icon' | 'auto' | 'full' }) {
  const s = ACCESS_STYLE[status];
  const size = mode === 'icon' ? 'w-6' : mode === 'auto' ? 'w-7 h-6 sm:w-auto sm:h-auto sm:min-w-[1.5rem]' : 'min-w-[1.5rem]';
  return (
    <span className={`inline-flex items-center justify-center gap-1 rounded border px-1 py-0.5 text-[0.62rem] uppercase tracking-label whitespace-nowrap ${s.className} ${size}`}>
      <span aria-hidden className="font-bold">{s.icon}</span>
      {mode !== 'icon' && <span className={mode === 'auto' ? 'hidden sm:inline' : ''}>{s.short}</span>}
    </span>
  );
}

function Detail({ cell, cloudLabel, onClose }: { cell: { regions: RegionAccess[] }; cloudLabel: string; onClose: () => void }) {
  return (
    <div className="space-y-3">
      {cell.regions.map((r) => (
        <div key={r.region} className="space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm text-slate-100">{cloudLabel} · {r.name}</p>
              <p className="text-[0.66rem] text-slate-500 font-mono break-all">{r.region}</p>
            </div>
            <Chip status={r.status} mode="full" />
          </div>
          <p className="text-xs text-slate-300">{r.summary}</p>
          {!!r.notSold?.length && r.status !== 'not-offered' && (
            <p className="text-[0.7rem] text-slate-400">⊘ {r.notSold.join(' and ')} machines aren’t sold in this region — only the other GPU{r.notSold.length > 1 ? 's' : ''} can launch here.</p>
          )}
          {(r.quotas.length > 0 || r.spot) && (
            <ul className="text-[0.7rem] text-slate-400 tabular-nums space-y-0.5">
              {r.quotas.map((q) => <QuotaRow key={q.label} q={q} />)}
              {r.spot && <QuotaRow q={r.spot} suffix={r.spotReady === false ? ' — too low for a spot machine' : r.spotReady ? ' — spot OK' : ''} />}
            </ul>
          )}
          {r.fix && (
            <div className="rounded border border-white/10 p-2 space-y-1.5">
              <p className="label">What to do</p>
              <ol className="list-decimal pl-4 text-xs text-slate-300 space-y-0.5">
                {r.fix.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
              {r.fix.consoleUrl && (
                <a href={r.fix.consoleUrl} target="_blank" rel="noreferrer" className="inline-block text-xs text-neon-cyan hover:underline">{r.fix.consoleLabel || 'Open the console'} ↗</a>
              )}
              {r.fix.cli && <Cli text={r.fix.cli} />}
            </div>
          )}
        </div>
      ))}
      <button type="button" onClick={onClose} className="text-[0.7rem] text-slate-500 hover:text-slate-300">Close</button>
    </div>
  );
}

function QuotaRow({ q, suffix = '' }: { q: { label: string; limit: number; used: number; unit: string }; suffix?: string }) {
  return (
    <li>
      <span className="text-slate-300">{q.label}:</span> {q.used} used of {q.limit} {q.unit}
      {q.limit - q.used <= 0 && q.limit > 0 ? ' (all in use)' : ''}{suffix}
    </li>
  );
}

function Cli({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded bg-black/40 border border-white/10 p-2 pr-14 text-[0.66rem] text-slate-300 whitespace-pre"><code className="!bg-transparent !border-0 !p-0">{text}</code></pre>
      <button type="button" className="absolute top-1 right-1 text-[0.62rem] text-neon-cyan border border-neon-cyan/40 rounded px-1.5 py-0.5 bg-cyber-darker"
        onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined)}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
