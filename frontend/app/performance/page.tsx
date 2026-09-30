'use client';

/**
 * ============================================================================
 * app/performance/page.tsx — HOW YOUR MACHINES ARE DOING (REAL DATA ONLY)
 * ============================================================================
 *
 * For each of your machines: its real state (from the cloud, re-checked
 * every 5 minutes), how long it has been up, what it's costing, and the
 * estimated ping from where you are to its region.
 *
 * GPU / FPS readings: shown only if real ones exist. Nothing records them
 * yet (the old job that invented random numbers is switched off — see
 * src/jobs/index.ts), so the page says so plainly and points to Moonlight's
 * own statistics overlay, which shows real FPS, latency and dropped frames
 * while you stream.
 * ============================================================================
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/auth';
import { useAuth } from '@/components/AuthProvider';

interface Machine {
  id: string; provider: string; region: string; instance_type: string; status: string;
  cost_per_hour: number; streaming_quality: string; game_title: string | null; spot: boolean;
  ip_address: string | null; created_at: string; last_started: string | null; last_synced_at: string | null;
}
interface Region { id: string; name: string; lat: number; lng: number }
interface Options { providers: Array<{ provider: string; label: string; regions: Region[] }> }
type Metric = Record<string, number | string | null>;

const STATUS_CLASS: Record<string, string> = {
  running: 'border-neon-lime/60 text-neon-lime', stopped: 'border-white/20 text-slate-400',
  creating: 'border-neon-cyan/60 text-neon-cyan', starting: 'border-neon-cyan/60 text-neon-cyan', stopping: 'border-neon-amber/60 text-neon-amber',
  error: 'border-neon-pink/60 text-neon-pink', missing: 'border-neon-pink/60 text-neon-pink',
};

function since(iso: string | null): string {
  if (!iso) return '—';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `${h} h ${mins % 60} min` : `${Math.floor(h / 24)} days`;
}
function pingMs(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return Math.round(5 + 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x))) * 0.015); // same estimate as the map
}

export default function PerformancePage() {
  const { user, loading: authLoading } = useAuth();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [regions, setRegions] = useState<Record<string, Region & { cloud: string }>>({});
  const [metrics, setMetrics] = useState<Record<string, Metric | null>>({});
  const [me, setMe] = useState<{ lat: number; lng: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, opts] = await Promise.all([apiFetch<Machine[]>('/machines'), apiFetch<Options>('/machines/options').catch(() => null)]);
      setMachines(list);
      if (opts) {
        const map: Record<string, Region & { cloud: string }> = {};
        for (const p of opts.providers) for (const r of p.regions) map[`${p.provider}:${r.id}`] = { ...r, cloud: p.label };
        setRegions(map);
      }
      // Real readings, if any exist (404 = none recorded).
      const entries = await Promise.all(list.map(async (m) => [m.id, await apiFetch<Metric>(`/performance/${m.id}/realtime`).catch(() => null)] as const));
      setMetrics(Object.fromEntries(entries));
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Couldn’t load your machines.');
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [user, load]);

  // Where you are: the place picked on Recon, else your connection's location.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('recon.place');
      if (saved) { const p = JSON.parse(saved); setMe({ lat: p.lat, lng: p.lng, label: p.label }); return; }
    } catch { /* ignore */ }
    fetch('/api/geo').then((r) => r.json()).then((g) => g.available && setMe({ lat: g.lat, lng: g.lng, label: g.city || 'your connection' })).catch(() => undefined);
  }, []);

  if (authLoading) return <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; LOADING…</p>;
  if (!user) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold neon-text font-mono">[ PERFORMANCE ]</h1>
        <p className="text-sm text-slate-400"><Link href="/login?next=/performance" className="text-neon-cyan hover:underline">Sign in</Link> to see your machines.</p>
      </div>
    );
  }

  const running = machines?.filter((m) => m.status === 'running') || [];

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold neon-text mb-1 font-mono">[ PERFORMANCE ]</h1>
          <p className="text-sm text-slate-400 short:hidden">Real state of your machines, re-checked with the cloud every few minutes.</p>
        </div>
        <button type="button" onClick={load} className="btn-neon text-xs">↻ Refresh</button>
      </div>

      {error && <p className="text-sm text-neon-amber">⚠ {error}</p>}

      {!machines ? (
        <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; READING_MACHINES…</p>
      ) : machines.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/15 p-6 text-sm text-slate-400">
          No machines yet. <Link href="/recommendations" className="text-neon-cyan hover:underline">Find the best region</Link> or <Link href="/machines" className="text-neon-cyan hover:underline">launch one</Link>.
        </div>
      ) : (
        <>
          <p className="text-xs text-slate-400 tabular-nums">
            {machines.length} machine{machines.length === 1 ? '' : 's'} · {running.length} running · ≈USD {running.reduce((s, m) => s + (Number(m.cost_per_hour) || 0), 0).toFixed(2)}/hour right now
            {me && <> · pings estimated from {me.label}</>}
          </p>
          <ul className="grid gap-3 lg:grid-cols-2">
            {machines.map((m) => {
              const r = regions[`${m.provider}:${m.region}`];
              const metric = metrics[m.id];
              return (
                <li key={m.id} className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-100 truncate">{m.instance_type}{m.game_title ? ` · ${m.game_title}` : ''}</p>
                      <p className="text-[0.7rem] text-slate-500">{r?.cloud || m.provider.toUpperCase()} · {r?.name || m.region}{m.spot ? ' · spot' : ''}</p>
                    </div>
                    <span className={`shrink-0 rounded border px-1.5 text-[0.7rem] uppercase tracking-label ${STATUS_CLASS[m.status] || 'border-white/20 text-slate-400'}`}>{m.status}</span>
                  </div>
                  <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <Stat label="Up for" value={m.status === 'running' ? since(m.last_started) : '—'} />
                    <Stat label="Cost" value={`≈USD ${(Number(m.cost_per_hour) || 0).toFixed(2)}/h`} />
                    <Stat label="Est. ping" value={me && r ? `~${pingMs(me, r)} ms` : '—'} />
                    <Stat label="Checked" value={m.last_synced_at ? `${since(m.last_synced_at)} ago` : '—'} />
                  </dl>
                  {metric ? (
                    <div className="rounded border border-white/10 px-2 py-1.5 text-xs text-slate-300">
                      <p className="label mb-1">Latest reading</p>
                      <p className="tabular-nums">
                        {([['gpuUsage', 'GPU', '%'], ['cpuUsage', 'CPU', '%'], ['streamingFps', 'FPS', ''], ['networkLatency', 'latency', ' ms']] as const)
                          .filter(([k]) => metric[k] != null).map(([k, name, unit]) => `${name} ${metric[k]}${unit}`).join(' · ') || 'Recorded, but empty.'}
                      </p>
                    </div>
                  ) : m.status === 'running' ? (
                    <p className="text-[0.7rem] text-slate-500">
                      No live GPU/FPS readings are recorded yet. While streaming, press <kbd className="rounded border border-white/20 px-1 text-slate-300">Ctrl</kbd>+<kbd className="rounded border border-white/20 px-1 text-slate-300">Alt</kbd>+<kbd className="rounded border border-white/20 px-1 text-slate-300">Shift</kbd>+<kbd className="rounded border border-white/20 px-1 text-slate-300">S</kbd> in Moonlight for its real stats overlay (FPS, network latency, decode time, dropped frames).
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.66rem] uppercase tracking-label text-slate-500">{label}</dt>
      <dd className="text-slate-200 tabular-nums truncate">{value}</dd>
    </div>
  );
}
