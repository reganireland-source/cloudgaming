'use client';

/**
 * ============================================================================
 * app/page.tsx — DASHBOARD: EVERYTHING AT A GLANCE (REAL DATA)
 * ============================================================================
 *
 *   Running now     machines running and what they cost per hour
 *   Standing cost   disks / snapshots / IPs billed even while stopped ($/mo)
 *   This month      estimated spend so far (hourly estimates, /api/costs)
 *   Leftovers       orphaned resources still costing money (from the map)
 * then your machines, recent cloud actions, and shortcuts.
 *
 * Sources: /api/machines, /api/inventory (live from each cloud, 60 s cache),
 * /api/costs/monthly and /api/operations. Signed out, it shows how to start.
 * ============================================================================
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import CloudLogo from '@/components/CloudLogo';
import { apiFetch } from '@/lib/auth';
import { useAuth } from '@/components/AuthProvider';

interface Machine {
  id: string; provider: string; region: string; instance_type: string; status: string;
  cost_per_hour: number; game_title: string | null; spot: boolean; created_at: string;
}
interface Inventory {
  clouds: string[];
  totals: { runningMachines: number; hourly: number; monthlyStanding: number; orphans: number; orphanMonthly: number; orphanHourly: number };
  errors: Array<{ provider: string; error: { title: string } }>;
}
interface Operation { id: string; provider: string; title: string; status: 'running' | 'succeeded' | 'failed'; created_at: string; last_message: string | null }

const CLOUD: Record<string, { color: string; letter: string; label: string }> = {
  gcp: { color: '#3987e5', letter: 'G', label: 'Google Cloud' }, aws: { color: '#c98500', letter: 'A', label: 'AWS' },
  azure: { color: '#199e70', letter: 'Z', label: 'Azure' }, oracle: { color: '#d55181', letter: 'O', label: 'Oracle' },
};
const STATUS_CLASS: Record<string, string> = {
  running: 'text-neon-lime', stopped: 'text-slate-400', error: 'text-neon-pink', missing: 'text-neon-pink',
};
const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`;
function ago(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

export default function Dashboard() {
  const { user, loading: authLoading } = useAuth();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [month, setMonth] = useState<number | null>(null);
  const [ops, setOps] = useState<Operation[]>([]);

  const load = useCallback(() => {
    apiFetch<Machine[]>('/machines').then(setMachines).catch(() => setMachines([]));
    apiFetch<Inventory>('/inventory').then(setInventory).catch(() => setInventory(null));
    apiFetch<{ total: number }>('/costs/monthly').then((c) => setMonth(Number(c.total) || 0)).catch(() => setMonth(null));
    apiFetch<Operation[]>('/operations?limit=6').then(setOps).catch(() => setOps([]));
  }, []);

  useEffect(() => {
    if (!user) return;
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [user, load]);

  if (authLoading) return <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; LOADING…</p>;

  if (!user) {
    return (
      <div className="space-y-4 max-w-2xl">
        <h1 className="text-xl font-bold neon-text font-mono">[ DASHBOARD ]</h1>
        <p className="text-sm text-slate-300">Run games on a cloud GPU in your own AWS, Google Cloud, Azure or Oracle account, and stream them to any screen with Moonlight.</p>
        <ol className="space-y-2 text-sm text-slate-400 list-decimal list-inside">
          <li><Link href="/login?next=/" className="text-neon-cyan hover:underline">Create an account or sign in</Link>.</li>
          <li>Add your cloud keys on <Link href="/settings" className="text-neon-cyan hover:underline">Config</Link> (they’re encrypted).</li>
          <li>Run the <Link href="/preflight" className="text-neon-cyan hover:underline">pre-flight check</Link>.</li>
          <li>Pick where and what on <Link href="/recommendations" className="text-neon-cyan hover:underline">Recon</Link>, then launch.</li>
        </ol>
      </div>
    );
  }

  const t = inventory?.totals;
  const running = machines?.filter((m) => m.status === 'running') || [];
  const hourly = t ? t.hourly : running.reduce((s, m) => s + (Number(m.cost_per_hour) || 0), 0);

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold neon-text mb-1 font-mono">[ DASHBOARD ]</h1>
          <p className="text-sm text-slate-400 short:hidden">Your machines and what they’re costing, straight from your clouds.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/recommendations" className="btn-neon-magenta text-xs">Find & launch</Link>
          <Link href="/map" className="btn-neon text-xs">Map</Link>
        </div>
      </div>

      {/* ---- Headline numbers ---- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <Tile label="Running now" value={`${money(hourly)}/h`} sub={`${t?.runningMachines ?? running.length} machine${(t?.runningMachines ?? running.length) === 1 ? '' : 's'} running`} />
        <Link href="/costs#standing" className="block hover:opacity-90"><Tile label="Standing cost" value={t ? `${money(t.monthlyStanding)}/mo` : '—'} sub="disks & snapshots, billed even when stopped — how to cut it →" /></Link>
        <Tile label="This month" value={month != null ? money(month) : '—'} sub="estimated so far" />
        <Tile label="Leftovers" value={t ? String(t.orphans) : '—'} sub={t && t.orphans ? `≈${money(t.orphanMonthly)}/mo wasted — see Map` : 'nothing orphaned'} warn={!!t?.orphans} href={t?.orphans ? '/map' : undefined} />
      </div>
      {inventory?.errors?.length ? (
        <p className="text-xs text-neon-amber">⚠ Couldn’t read {inventory.errors.map((e) => CLOUD[e.provider]?.label || e.provider).join(', ')} just now — numbers from it may be missing. Details on the <Link href="/map" className="underline">Map</Link>.</p>
      ) : null}

      <div className="grid gap-4 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1.4fr),minmax(0,1fr)]">
        {/* ---- Machines ---- */}
        <section className="space-y-2">
          <div className="flex items-baseline justify-between"><h2 className="label">Your machines</h2><Link href="/machines" className="text-xs text-neon-cyan hover:underline">Manage →</Link></div>
          {!machines ? <p className="text-xs text-slate-500">Loading…</p> : machines.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/15 p-4 text-sm text-slate-400">
              No machines yet. Start with <Link href="/preflight" className="text-neon-cyan hover:underline">pre-flight</Link>, then <Link href="/recommendations" className="text-neon-cyan hover:underline">Recon</Link> to pick a region.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {[...machines].sort((a, b) => {
                // Live machines first (running → busy → stopped), failed last; newest first within each.
                const rank = (s: string) => ({ running: 0, creating: 1, starting: 1, stopping: 1, deleting: 1, shelving: 1, restoring: 1, stopped: 2, shelved: 3 } as Record<string, number>)[s] ?? 3;
                return rank(a.status) - rank(b.status) || new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
              }).slice(0, 8).map((m) => {
                const c = CLOUD[m.provider] || { color: '#94a3b8', letter: '?', label: m.provider };
                return (
                  <li key={m.id}>
                    <Link href="/machines" className="flex items-center gap-2.5 rounded border border-white/10 bg-white/[0.02] px-2.5 py-2 hover:border-white/25">
                      <CloudLogo provider={m.provider} size={20} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-slate-100 truncate">{m.instance_type}{m.game_title ? ` · ${m.game_title}` : ''}</span>
                        <span className="block text-[0.7rem] text-slate-500 truncate">{c.label} · {m.region}{m.spot ? ' · spot' : ''}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className={`block text-[0.66rem] uppercase tracking-label ${STATUS_CLASS[m.status] || 'text-neon-cyan'}`}>{m.status}</span>
                        <span className="block text-[0.7rem] text-slate-400 tabular-nums">{money(m.cost_per_hour)}/h</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ---- Recent cloud actions ---- */}
        <section className="space-y-2">
          <h2 className="label">Recent activity</h2>
          {ops.length === 0 ? <p className="text-xs text-slate-500">Nothing yet — launches, starts and stops show up here with their live logs.</p> : (
            <ul className="space-y-1.5">
              {ops.map((o) => (
                <li key={o.id} className="rounded border border-white/10 px-2.5 py-2">
                  <p className="text-sm text-slate-200 flex items-center gap-2">
                    <span className={o.status === 'failed' ? 'text-neon-pink' : o.status === 'running' ? 'text-neon-cyan animate-pulse' : 'text-neon-lime'} aria-label={o.status}>
                      {o.status === 'failed' ? '✗' : o.status === 'running' ? '●' : '✓'}
                    </span>
                    <span className="truncate">{o.title}</span>
                  </p>
                  <p className="text-[0.7rem] text-slate-500 truncate">{ago(o.created_at)}{o.last_message ? ` · ${o.last_message}` : ''}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, warn, href }: { label: string; value: string; sub: string; warn?: boolean; href?: string }) {
  const body = (
    <div className={`h-full rounded border px-3 py-2.5 ${warn ? 'border-neon-pink/40 bg-neon-pink/[0.04]' : 'border-white/10 bg-white/[0.02]'}`}>
      <p className="label">{label}</p>
      <p className="text-lg text-slate-100 tabular-nums mt-0.5">{value}</p>
      <p className="text-[0.68rem] text-slate-500 mt-0.5 leading-snug">{sub}</p>
    </div>
  );
  return href ? <Link href={href} className="block">{body}</Link> : body;
}
