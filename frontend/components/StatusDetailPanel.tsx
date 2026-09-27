'use client';

/**
 * ============================================================================
 * frontend/components/StatusDetailPanel.tsx — "IS IT REALLY WORKING?" STATS
 * ============================================================================
 *
 * Opened by clicking any status light (components/SystemStatusBar.tsx). Shows
 * the numbers behind that light, from GET /api/status/details (backend:
 * src/api/routes/status.ts), refreshed every 10 seconds:
 *
 *   BACKEND   uptime, memory, CPU load, requests per minute (chart),
 *             average response time, errors, slowest requests
 *   DATABASE  Postgres version, size, tables, migrations, connections,
 *             query latency history (chart) and success rate
 *   AWS / AZURE / GCP / ORACLE
 *             which API address is probed, the HTTP answer, the IP we reached,
 *             latency history (chart), success rate — plus, if you're signed
 *             in, YOUR keys and machines on that cloud.
 *
 * The status data is public and aggregate only (no user data); the "your
 * account" part uses your own sign-in and only shows your own things.
 *
 * CHARTS: small hand-drawn SVG bar charts (no library). One series each, so
 * no legend; failed checks are drawn as a short pink bar marked ✗ and named
 * in the hover tooltip, so failure is never shown by colour alone.
 * ============================================================================
 */

import { useEffect, useState } from 'react';
import { apiUrl } from '@/lib/api';
import { apiFetch } from '@/lib/auth';
import { useAuth } from './AuthProvider';

export type LightKey = 'backend' | 'database' | 'aws' | 'azure' | 'gcp' | 'oracle';

interface HistoryPoint { at: string; ok: boolean; latencyMs?: number; httpStatus?: number; detail?: string }
interface Summary {
  checks: number; successRate: number | null; latencyMin: number | null; latencyMedian: number | null;
  latencyP95: number | null; latencyMax: number | null; lastFailure: HistoryPoint | null;
}
interface Details {
  generatedAt: string;
  backend: {
    uptimeSeconds: number; startedAt: string; nodeVersion: string; environment: string; gitCommit: string | null;
    railwayRegion: string | null; memoryMb: { rss: number; heapUsed: number; heapTotal: number }; cpuCores: number;
    loadAverage: number[];
    requests: {
      requests: number; errors4xx: number; errors5xx: number; avgResponseMs: number | null; requestsLastMinute: number;
      perMinute: Array<{ minute: string; requests: number; errors: number }>;
      slowest: Array<{ path: string; ms: number; at: string }>;
    };
  };
  database: {
    connected: boolean; error?: string; queryMs?: number; version?: string; sizeMb?: number; activeConnections?: number;
    pool?: { total: number; idle: number; waiting: number }; tables?: number; migrationsApplied?: number;
    latestMigration?: string; latestMigrationAt?: string; history: HistoryPoint[]; summary: Summary;
  };
  providers: Record<string, {
    probeUrl: string; connected: boolean | null; latencyMs: number | null; httpStatus: number | null;
    remoteAddress: string | null; detail: string | null; checkedAt: string | null; history: HistoryPoint[]; summary: Summary;
  }>;
}

const TABS: Array<{ key: LightKey; label: string }> = [
  { key: 'backend', label: 'Backend' },
  { key: 'database', label: 'Database' },
  { key: 'aws', label: 'AWS' },
  { key: 'azure', label: 'Azure' },
  { key: 'gcp', label: 'GCP' },
  { key: 'oracle', label: 'Oracle' },
];

const CLOUD_NAME: Record<string, string> = { aws: 'AWS', azure: 'Azure', gcp: 'Google Cloud', oracle: 'Oracle Cloud' };
const CLOUD_API: Record<string, string> = {
  aws: 'EC2 API', azure: 'Azure Resource Manager', gcp: 'Compute Engine API', oracle: 'OCI API',
};

function formatUptime(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** One headline number. */
function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-white/10 bg-white/[0.02] px-3 py-2.5">
      <p className="label">{label}</p>
      <p className="text-lg text-slate-100 tabular-nums mt-0.5">{value}</p>
      {sub && <p className="text-[0.68rem] text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

/** Label/value rows. */
function Rows({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-500">{k}</dt>
          <dd className="text-slate-200 font-mono break-all">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A small bar chart. Each bar is one value over time; hover a bar for its
 * exact value and time. `failed` bars are drawn short, pink and marked ✗.
 */
function BarChart({
  points, unit, emptyText,
}: {
  points: Array<{ value: number; label: string; failed?: boolean }>;
  unit: string;
  emptyText: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return <p className="text-xs text-slate-500">{emptyText}</p>;
  const W = 560, H = 96, top = 8, bottom = 16;
  const max = Math.max(1, ...points.map((p) => p.value));
  // Always lay out at least 24 slots, newest on the right, so a handful of
  // early checks don't turn into a few giant bars.
  const slots = Math.max(points.length, 24);
  const slot = W / slots;
  const offset = (slots - points.length) * slot;
  const barW = Math.max(2, slot - 2); // 2px gap between bars
  const y = (v: number) => H - bottom - ((H - top - bottom) * v) / max;
  const h = hover !== null ? points[hover] : null;

  return (
    <div className="relative">
      {/* Hover readout — text in text colours, never the bar colour. */}
      <p className="text-[0.68rem] text-slate-400 h-4 mb-1 tabular-nums">
        {h ? `${h.label} · ${h.failed ? '✗ failed' : `${h.value} ${unit}`}` : `max ${Math.round(max)} ${unit} · hover a bar for details`}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`Bar chart, ${points.length} values in ${unit}`}>
        {/* Recessive baseline and max gridline */}
        <line x1={0} x2={W} y1={H - bottom} y2={H - bottom} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
        <line x1={0} x2={W} y1={top} y2={top} stroke="rgba(255,255,255,0.05)" strokeWidth={1} strokeDasharray="3 4" />
        {points.map((p, i) => {
          const x = offset + i * slot + 1;
          const barTop = p.failed ? H - bottom - 10 : y(p.value);
          const height = Math.max(2, H - bottom - barTop);
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* invisible, taller hit area so thin bars are easy to hover */}
              <rect x={offset + i * slot} y={0} width={slot} height={H} fill="transparent" />
              <rect
                x={x} y={barTop} width={barW} height={height} rx={Math.min(2, barW / 2)}
                fill={p.failed ? '#ec8aa8' : '#5fd7e0'}
                opacity={hover === null || hover === i ? 0.9 : 0.45}
              />
              {p.failed && barW >= 6 && (
                <text x={x + barW / 2} y={barTop - 2} textAnchor="middle" fontSize={8} fill="#ec8aa8">✗</text>
              )}
            </g>
          );
        })}
        {/* Oldest time label, unless it would collide with the newest one. */}
        {offset < W - 140 && <text x={offset} y={H - 3} fontSize={9} fill="#64748b">{points[0].label}</text>}
        <text x={W} y={H - 3} fontSize={9} fill="#64748b" textAnchor="end">{points[points.length - 1].label}</text>
      </svg>
    </div>
  );
}

function historyBars(history: HistoryPoint[]) {
  return history.map((p) => ({ value: p.latencyMs ?? 0, label: time(p.at), failed: !p.ok }));
}

function SummaryTiles({ summary, now }: { summary: Summary; now: string }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <Tile label="Latency now" value={now} />
      <Tile label="Median" value={summary.latencyMedian !== null ? `${summary.latencyMedian} ms` : '—'} sub={`p95 ${summary.latencyP95 ?? '—'} ms`} />
      <Tile label="Success" value={summary.successRate !== null ? `${summary.successRate}%` : '—'} sub={`${summary.checks} checks`} />
      <Tile label="Range" value={summary.latencyMin !== null ? `${summary.latencyMin}–${summary.latencyMax} ms` : '—'} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Your account" section for a cloud (signed-in users only)
// ---------------------------------------------------------------------------
function YourCloud({ provider }: { provider: string }) {
  const { user } = useAuth();
  const [data, setData] = useState<{ saved: any; machines: any[] } | null>(null);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      apiFetch<{ providers: Array<{ provider: string; saved: any }> }>('/credentials'),
      apiFetch<any[]>('/machines'),
    ])
      .then(([creds, machines]) => setData({
        saved: creds.providers.find((p) => p.provider === provider)?.saved || null,
        machines: machines.filter((m) => m.provider === provider),
      }))
      .catch(() => setData(null));
  }, [user, provider]);

  if (!user) return <p className="text-xs text-slate-500">Sign in to see your {CLOUD_NAME[provider]} keys and machines here.</p>;
  if (!data) return <p className="text-xs text-slate-500 animate-pulse">&gt; loading your account…</p>;
  const running = data.machines.filter((m) => m.status === 'running');
  const hourly = running.reduce((s, m) => s + (Number(m.cost_per_hour) || 0), 0);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <Tile label="Your keys" value={data.saved ? (data.saved.lastCheckOk === false ? '⚠ check' : '✓ saved') : 'none'}
          sub={data.saved?.lastCheckedAt ? `checked ${new Date(data.saved.lastCheckedAt).toLocaleDateString()}` : 'add on Config'} />
        <Tile label="Machines" value={`${data.machines.length}`} sub={`${running.length} running`} />
        <Tile label="Spend now" value={`≈$${hourly.toFixed(2)}/h`} sub="estimated" />
      </div>
      {data.saved?.lastCheckSummary && <p className="text-xs text-slate-400">Last key check: {data.saved.lastCheckSummary}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------
export default function StatusDetailPanel({ initial, onClose }: { initial: LightKey; onClose: () => void }) {
  const [tab, setTab] = useState<LightKey>(initial);
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load now, then every 10 s while open.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(apiUrl('/status/details'), { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) { setDetails(data); setError(null); }
      } catch (e: any) {
        if (!cancelled) setError(e.message === 'HTTP 404'
          ? 'The backend is reachable but is an older version without this endpoint — redeploy the backend on Railway.'
          : `Couldn't reach the backend (${e.message}). Check the BACKEND light and NEXT_PUBLIC_API_URL.`);
      }
    };
    load();
    const timer = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const b = details?.backend;
  const db = details?.database;
  const cloud = details && ['aws', 'azure', 'gcp', 'oracle'].includes(tab) ? details.providers[tab] : null;

  return (
    <div className="fixed inset-0 !m-0 bg-black/75 z-50 flex items-start justify-center p-0 sm:p-4 sm:pt-20 short:sm:pt-4 overflow-y-auto" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Service status details"
        className="bg-cyber-dark border border-neon-cyan/30 rounded-none sm:rounded-lg w-full max-w-3xl min-h-[100dvh] sm:min-h-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-3 sm:px-5 py-3 sticky top-0 bg-cyber-dark z-10">
          <h2 className="text-sm tracking-label font-bold font-mono neon-text whitespace-nowrap">[ SYSTEM_STATUS ]</h2>
          <div className="flex items-center gap-3 sm:gap-4">
            {details && <span className="text-[0.66rem] text-slate-500 hidden xs:inline">updated {time(details.generatedAt)} · every 10 s</span>}
            <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm font-mono whitespace-nowrap">[ CLOSE ]</button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1 px-3 sm:px-5 pt-3 border-b border-white/5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 text-[0.68rem] uppercase tracking-label border-b-2 -mb-px ${
                tab === t.key ? 'border-neon-cyan text-neon-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="p-3 sm:p-5 space-y-4 sm:space-y-5">
          {error && <p className="text-sm text-neon-pink">✗ {error}</p>}
          {!details && !error && <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; LOADING_STATS…</p>}

          {/* ---------------- BACKEND ---------------- */}
          {b && tab === 'backend' && (
            <>
              <p className="text-sm text-slate-300">
                The Express API running in a container on Railway. It&apos;s answering — here&apos;s what it&apos;s been doing.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Tile label="Uptime" value={formatUptime(b.uptimeSeconds)} sub={`since ${new Date(b.startedAt).toLocaleString()}`} />
                <Tile label="Requests" value={b.requests.requests.toLocaleString()} sub={`${b.requests.requestsLastMinute} in the last minute`} />
                <Tile label="Avg response" value={b.requests.avgResponseMs !== null ? `${b.requests.avgResponseMs} ms` : '—'} />
                <Tile label="Server errors" value={`${b.requests.errors5xx}`} sub={`${b.requests.errors4xx} client errors (4xx)`} />
              </div>
              <div>
                <p className="label mb-1">Requests per minute · last 30 minutes</p>
                <BarChart
                  points={b.requests.perMinute.map((m) => ({ value: m.requests, label: new Date(m.minute).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), }))}
                  unit="requests"
                  emptyText="No requests yet."
                />
              </div>
              <div className="grid sm:grid-cols-2 gap-5">
                <Rows rows={[
                  ['memory', `${b.memoryMb.rss} MB in use (heap ${b.memoryMb.heapUsed} / ${b.memoryMb.heapTotal} MB)`],
                  ['cpu', `${b.cpuCores} cores · load ${b.loadAverage.join(' / ')}`],
                  ['node', b.nodeVersion],
                  ['environment', b.environment],
                  ['region', b.railwayRegion],
                  ['commit', b.gitCommit],
                ]} />
                <div>
                  <p className="label mb-1">Slowest requests since start</p>
                  <ul className="space-y-1 text-xs font-mono">
                    {b.requests.slowest.length === 0 && <li className="text-slate-500">—</li>}
                    {b.requests.slowest.map((r, i) => (
                      <li key={i} className="flex justify-between gap-3">
                        <span className="text-slate-300 truncate">{r.path}</span>
                        <span className="text-slate-400 tabular-nums">{r.ms} ms</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <p className="text-[0.68rem] text-slate-500">Counts reset when the backend restarts (each Railway deploy).</p>
            </>
          )}

          {/* ---------------- DATABASE ---------------- */}
          {db && tab === 'database' && (
            <>
              <p className="text-sm text-slate-300">
                Postgres on Railway: accounts, machines, the activity log and your encrypted cloud keys. Latency is a tiny
                “SELECT 1” round trip from the backend.
              </p>
              {!db.connected && <p className="text-sm text-neon-pink">✗ Not reachable: {db.error}</p>}
              <SummaryTiles summary={db.summary} now={db.queryMs !== undefined ? `${db.queryMs} ms` : '—'} />
              <div>
                <p className="label mb-1">Query latency · recent checks</p>
                <BarChart points={historyBars(db.history)} unit="ms" emptyText="No checks recorded yet — they build up while the site is open." />
              </div>
              <Rows rows={[
                ['version', db.version],
                ['size', db.sizeMb !== undefined ? `${db.sizeMb} MB` : undefined],
                ['tables', db.tables],
                ['migrations', db.migrationsApplied !== undefined ? `${db.migrationsApplied} applied · latest ${db.latestMigration}` : undefined],
                ['connections', db.activeConnections !== undefined ? `${db.activeConnections} open to this database` : undefined],
                ['backend pool', db.pool ? `${db.pool.total} connections (${db.pool.idle} idle, ${db.pool.waiting} waiting)` : undefined],
              ]} />
              {db.summary.lastFailure && (
                <p className="text-xs text-neon-amber">⚠ Last failed check at {time(db.summary.lastFailure.at)}: {db.summary.lastFailure.detail}</p>
              )}
            </>
          )}

          {/* ---------------- CLOUDS ---------------- */}
          {cloud && (
            <>
              <p className="text-sm text-slate-300">
                The backend checks it can reach {CLOUD_NAME[tab]}&apos;s {CLOUD_API[tab]} over the internet. Any HTTP answer —
                even “401 Unauthorized” — proves the path works; the check doesn&apos;t use anyone&apos;s keys.
              </p>
              <SummaryTiles summary={cloud.summary} now={cloud.latencyMs !== null ? `${cloud.latencyMs} ms` : '—'} />
              <div>
                <p className="label mb-1">Round-trip latency from Railway · recent checks</p>
                <BarChart points={historyBars(cloud.history)} unit="ms" emptyText="No checks recorded yet — they build up while the site is open." />
              </div>
              <Rows rows={[
                ['probed address', cloud.probeUrl],
                ['answered with', cloud.httpStatus ? `HTTP ${cloud.httpStatus}${cloud.httpStatus >= 400 ? ' (expected without keys — still reachable)' : ''}` : cloud.detail || '—'],
                ['connected to', cloud.remoteAddress],
                ['last check', cloud.checkedAt ? time(cloud.checkedAt) : undefined],
              ]} />
              {cloud.summary.lastFailure && (
                <p className="text-xs text-neon-amber">⚠ Last failed check at {time(cloud.summary.lastFailure.at)}: {cloud.summary.lastFailure.detail}</p>
              )}
              <div className="border-t border-white/5 pt-4">
                <p className="label mb-2">Your {CLOUD_NAME[tab]} account</p>
                <YourCloud provider={tab} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
