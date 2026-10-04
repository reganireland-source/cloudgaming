'use client';

/**
 * ============================================================================
 * frontend/app/machines/page.tsx — YOUR GAMING MACHINES (/machines)
 * ============================================================================
 *
 * The main working page. Everything here is REAL: it reads your machines
 * from the backend and every button performs a real cloud action in your
 * own cloud account (billed to you by that cloud).
 *
 * WHAT'S ON IT
 * ------------
 *  - [ LAUNCH_MACHINE ] opens the launch form (components/LaunchMachineModal).
 *  - One card per machine: status, price, IP, and buttons that change with
 *    its state (Start / Stop / Sync / Delete). Destructive actions ask to
 *    confirm first.
 *  - Each card expands into three tabs:
 *      Connect       IP, Sunshine login, setup progress, Moonlight steps
 *      Architecture  a live diagram of everything deployed for it, from
 *                    Vercel and Railway down to the GPU, with explanations
 *      Activity      every action taken on it, with full logs
 *  - Pressing an action shows its live log right under the card
 *    (components/OperationConsole), so you see exactly what the cloud is
 *    doing and — if it fails — why, and how to fix it.
 *  - An Activity panel lists your recent actions across all machines.
 *
 * DATA FLOW
 * ---------
 * GET /api/machines (refreshed every 8 s while anything is changing, every
 * 30 s otherwise) → cards. Actions POST to /api/machines/:id/<action>, get
 * back an operation id (HTTP 202), and the console follows it.
 *
 * The page needs you signed in: <RequireAuth> sends you to /login otherwise.
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usd, usdRange } from '@/lib/money';
import { RequireAuth } from '@/components/AuthProvider';
import { apiFetch, ApiError, type FriendlyError } from '@/lib/auth';
import LaunchMachineModal from '@/components/LaunchMachineModal';
import OperationConsole from '@/components/OperationConsole';
import DiskMeter from '@/components/DiskMeter';
import TelemetryPanel from '@/components/TelemetryPanel';
import FriendlyErrorCard from '@/components/FriendlyErrorCard';
import MachineConnectionPanel, { type ConnectionInfo } from '@/components/MachineConnectionPanel';
import ArchitectureDiagram from '@/components/ArchitectureDiagram';
import ThemedSelect from '@/components/ThemedSelect';
import { byDistance, useMyPlace } from '@/lib/myPlace';

interface Machine {
  id: string;
  /** Editable name, e.g. GOOGLE-SINGAPORE-L4-BEST-S-BS; also what Moonlight lists. */
  nickname: string | null;
  provider: string;
  region: string;
  instance_type: string;
  instance_id: string;
  status: string;
  cost_per_hour: number;
  streaming_quality: string;
  game_title: string | null;
  spot: boolean;
  disk_size_gb: number | null;
  ip_address: string | null;
  last_error: FriendlyError | null;
  created_at: string;
  last_started: string | null;
  last_synced_at: string | null;
  shelved_at: string | null;
  stopped_at: string | null;
  auto_shelve_days: number | null;
  standing: Standing | null;
  display_driver?: 'standard' | 'grid';
}

/** Monthly cost while not playing (see standingFor in src/api/routes/machines.ts). */
interface Standing {
  diskGb: number;
  diskMonthly: number;                     // the disk, billed while it exists (stopped too)
  shelfMonthly: number | null;             // a shelved machine's snapshot
  shelfExact: boolean;                     // shelfMonthly from the GB actually stored
  storedGb: number | null;
  shelfEstimate: { low: number; high: number }; // if shelved now: fresh install … full disk
  restoreAnyRegion: boolean;
}
type Region = { id: string; name: string; gpus: string[]; lat?: number; lng?: number };
type Action = 'start' | 'stop' | 'stop-shelve' | 'shelve' | 'restore' | 'sync' | 'delete' | 'resume-setup' | 'pricing' | 'disk' | 'update-script';
/** Clouds that switch an existing (stopped) machine between spot and on-demand in place; others do it via Shelve → Restore. */
const PRICING_IN_PLACE = new Set(['gcp']);
const AUTO_SHELVE = [1, 3, 7, 14, 30];
const money = (n: number) => usd(n);
const daysSince = (iso: string | null) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null);

interface OperationSummary {
  id: string;
  machine_id: string | null;
  provider: string;
  action: string;
  title: string;
  status: 'running' | 'succeeded' | 'failed';
  error: FriendlyError | null;
  created_at: string;
  finished_at: string | null;
  last_message: string | null;
}

const PROVIDER_LABEL: Record<string, string> = { gcp: 'Google Cloud', aws: 'AWS', azure: 'Azure', oracle: 'Oracle' };
const BUSY = ['creating', 'starting', 'stopping', 'deleting', 'shelving', 'restoring'];

/** Colour + wording for each machine state. */
function statusStyle(status: string): { text: string; cls: string; hint: string } {
  switch (status) {
    case 'running': return { text: 'running', cls: 'border-neon-lime/60 text-neon-lime', hint: 'Billing by the hour.' };
    case 'stopped': return { text: 'stopped', cls: 'border-white/20 text-slate-400', hint: 'No compute charge; the disk is still billed monthly.' };
    case 'creating': return { text: 'creating', cls: 'border-neon-amber/60 text-neon-amber', hint: 'Being created at the cloud…' };
    case 'starting': return { text: 'starting', cls: 'border-neon-amber/60 text-neon-amber', hint: 'Powering on…' };
    case 'stopping': return { text: 'stopping', cls: 'border-neon-amber/60 text-neon-amber', hint: 'Powering off…' };
    case 'deleting': return { text: 'deleting', cls: 'border-neon-amber/60 text-neon-amber', hint: 'Being destroyed…' };
    case 'shelved': return { text: 'shelved', cls: 'border-neon-purple/60 text-neon-purple', hint: 'Machine and disk deleted; your games are kept in a snapshot. Restore to play.' };
    case 'shelving': return { text: 'shelving', cls: 'border-neon-amber/60 text-neon-amber', hint: 'Snapshotting the disk, then deleting the machine…' };
    case 'restoring': return { text: 'restoring', cls: 'border-neon-amber/60 text-neon-amber', hint: 'Rebuilding the machine from its snapshot…' };
    case 'failed': return { text: 'failed', cls: 'border-neon-pink/60 text-neon-pink', hint: 'The last action failed — see below.' };
    case 'missing': return { text: 'missing', cls: 'border-neon-pink/60 text-neon-pink', hint: 'The cloud says it no longer exists.' };
    default: return { text: status, cls: 'border-white/20 text-slate-400', hint: 'State unknown — press Sync.' };
  }
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Mid-change (starting/stopping…) with no action running here, and not
 * confirmed with the cloud for 10+ minutes: something was lost (a redeploy,
 * or the cloud is still finishing). The page re-checks such machines itself.
 */
function isStuck(m: Machine, activeOp: string | null): boolean {
  if (activeOp || !['starting', 'stopping', 'deleting', 'shelving', 'restoring', 'unknown'].includes(m.status)) return false;
  if (/^(pending|shelved):/.test(m.instance_id)) return false;
  const last = new Date(m.last_synced_at || m.created_at).getTime();
  return Date.now() - last > 10 * 60_000;
}

/** "Auto-shelve after N days stopped" — off by default for existing machines. */
function AutoShelvePicker({ value, saving, onChange, inline }: { value: number | null; saving: boolean; onChange: (d: number | null) => void; inline?: boolean }) {
  return (
    <label className={`${inline ? 'inline-flex' : 'flex'} flex-wrap items-center gap-1.5 text-slate-400`}>
      <span>Auto-shelve after</span>
      <ThemedSelect compact value={String(value ?? 0)} disabled={saving} onChange={(v) => onChange(Number(v) || null)} ariaLabel="Auto-shelve after"
        className="inline-block min-w-[9rem]"
        options={[{ value: '0', label: 'off' }, ...AUTO_SHELVE.map((d) => ({ value: String(d), label: `${d} day${d === 1 ? '' : 's'} stopped` }))]} />
      {saving && <span className="text-neon-cyan animate-pulse">saving…</span>}
    </label>
  );
}

interface ShapeInfo { id: string; gpuModel: string; vcpus: number; memoryGb: number; label: string; prices?: Record<string, { onDemand: number; spot: number | null }> }
type TierId = 'good' | 'better' | 'best' | 'super';

/** Recon's hardware tiers (same rule as tierOf in src/services/ReconService.ts). */
function tierOf(sh: ShapeInfo): TierId {
  if (sh.gpuModel === 'L40S' || sh.gpuModel === 'RTX PRO 6000') return 'super';
  if (sh.gpuModel === 'T4') return 'good';
  if (sh.gpuModel === 'A10') return 'best';
  return sh.vcpus >= 8 ? 'best' : 'better';
}
const TIER_STYLE: Record<TierId, { label: string; cls: string; bars: number; note: string }> = {
  good: { label: 'Good', cls: 'text-neon-cyan border-neon-cyan/40', bars: 1, note: '1080p60 · indie, esports, older AAA' },
  better: { label: 'Better', cls: 'text-neon-lime border-neon-lime/40', bars: 2, note: '1440p60 · modern AAA' },
  best: { label: 'Best', cls: 'text-neon-magenta border-neon-magenta/50', bars: 3, note: 'up to 1440p/4K · demanding and CPU-heavy games' },
  super: { label: 'Super', cls: 'text-neon-amber border-neon-amber/60', bars: 4, note: '4K · modern AAA with ray tracing and DLSS frame generation' },
};

/** GOOD / BETTER / BEST / SUPER — the Recon tier this machine's hardware falls in. */
function TierBadge({ shape }: { shape: ShapeInfo }) {
  const t = TIER_STYLE[tierOf(shape)];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[0.66rem] uppercase tracking-label border rounded px-1.5 py-0.5 ${t.cls}`}
      title={`${t.label} tier: ${shape.gpuModel} GPU · ${shape.vcpus} vCPU · ${shape.memoryGb} GB RAM — ${t.note}`}>
      <span aria-hidden className="inline-flex items-end gap-px h-2.5">
        {[1, 2, 3, 4].map((b) => <span key={b} className={`w-[3px] rounded-sm ${b <= t.bars ? 'bg-current' : 'bg-current opacity-25'}`} style={{ height: `${b * 25}%` }} />)}
      </span>
      {t.label}
      <span className="normal-case tracking-normal text-slate-400">{shape.gpuModel} · {shape.vcpus} vCPU</span>
    </span>
  );
}

/**
 * The machine's nickname, editable in place. Moonlight lists the machine by
 * it (Sunshine reads it from the cloud tag at each start). Empty + Save =
 * back to the default CLOUD-CITY-GPU-TIER[-S][-BS] name.
 */
function Nickname({ machine, onRenamed }: { machine: Machine; onRenamed: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(machine.nickname || '');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!editing) setValue(machine.nickname || ''); }, [machine.nickname, editing]);
  const save = async (name: string) => {
    setSaving(true); setError(null);
    try {
      const r = await apiFetch<{ nickname: string; note: string }>(`/machines/${machine.id}/nickname`, { method: 'POST', body: { nickname: name } });
      setValue(r.nickname); setNote(r.note); setEditing(false); onRenamed();
      setTimeout(() => setNote(null), 12000);
    } catch (e) {
      setError((e as ApiError).message || 'Couldn’t rename it.');
    } finally { setSaving(false); }
  };
  if (editing) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <input autoFocus value={value} maxLength={40} onChange={(e) => setValue(e.target.value)} aria-label="Machine nickname"
          onKeyDown={(e) => { if (e.key === 'Enter') save(value); if (e.key === 'Escape') setEditing(false); }}
          className="input-neon px-2 py-0.5 text-sm font-semibold w-72 max-w-full" />
        <button type="button" disabled={saving} onClick={() => save(value)} className="btn-neon text-xs disabled:opacity-40">{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" disabled={saving} onClick={() => save('')} className="text-[0.7rem] text-slate-400 hover:text-slate-200" title="Back to CLOUD-CITY-GPU-TIER[-S][-BS]">Default</button>
        <button type="button" onClick={() => { setEditing(false); setError(null); }} className="text-[0.7rem] text-slate-500 hover:text-slate-300">Cancel</button>
        {error && <span className="basis-full text-[0.7rem] text-neon-amber">⚠ {error}</span>}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span className="text-sm font-semibold text-slate-100 break-all">{machine.nickname || machine.instance_type}</span>
      <button type="button" onClick={() => setEditing(true)} className="text-[0.7rem] text-neon-cyan/80 hover:text-neon-cyan" aria-label="Rename" title="Rename (Moonlight shows this name)">✎</button>
      {note && <span className="text-[0.66rem] text-slate-400">{note}</span>}
    </span>
  );
}

function MachineCard({
  machine, activeOp, onAction, onOpFinished, regions, shape, bigExtra = 0,
}: {
  machine: Machine;
  shape?: ShapeInfo;
  /** Big-screen surcharge per hour on this cloud (added to grid machines' prices). */
  bigExtra?: number;
  activeOp: string | null;
  onAction: (machine: Machine, action: Action, body?: Record<string, unknown>) => Promise<void> | void;
  onOpFinished: () => void;
  regions: Region[];
}) {
  const place = useMyPlace(); // restore regions nearest-first
  // Spot <-> on-demand: price per hour for either, where known.
  const priceFor = (spot: boolean, region = machine.region) => {
    const p = shape?.prices?.[region];
    const v = p ? (spot ? p.spot : p.onDemand) : null;
    return v != null ? v + (machine.display_driver === 'grid' ? bigExtra : 0) : null;
  };
  const canSwitchNow = machine.status === 'shelved' || (PRICING_IN_PLACE.has(machine.provider) && ['stopped', 'running'].includes(machine.status));
  const [tab, setTab] = useState<'connect' | 'monitor' | 'architecture' | 'activity' | null>(machine.status === 'running' ? 'connect' : null);
  const [confirm, setConfirm] = useState<'stop' | 'delete' | 'shelve' | 'restore' | 'pricing' | null>(null);
  const [restoreRegion, setRestoreRegion] = useState(machine.region);
  const [restoreSpot, setRestoreSpot] = useState(!!machine.spot);
  const [keepSnapshot, setKeepSnapshot] = useState(false);
  const [autoShelve, setAutoShelve] = useState<number | null>(machine.auto_shelve_days);
  const [autoSaving, setAutoSaving] = useState(false);
  const sd = machine.standing;
  const changeAutoShelve = async (days: number | null) => {
    setAutoSaving(true);
    try { const r = await apiFetch<{ autoShelveDays: number | null }>(`/machines/${machine.id}/auto-shelve`, { method: 'POST', body: { days } }); setAutoShelve(r.autoShelveDays); }
    catch { /* keep the old value */ } finally { setAutoSaving(false); }
  };
  const [stage, setStage] = useState<ConnectionInfo['setup']['current']>(null);
  const [history, setHistory] = useState<OperationSummary[] | null>(null);
  const [openOp, setOpenOp] = useState<string | null>(null);
  const st = statusStyle(machine.status);
  const busy = BUSY.includes(machine.status) || !!activeOp;
  const stale = isStuck(machine, activeOp);
  const placeholderId = /^(pending|shelved):/.test(machine.instance_id);
  const [zone, name] = placeholderId ? ['', ''] : machine.instance_id.split('/');

  useEffect(() => {
    if (tab !== 'activity') return;
    apiFetch<OperationSummary[]>(`/operations?machineId=${machine.id}&limit=30`).then(setHistory).catch(() => setHistory([]));
  }, [tab, machine.id, activeOp]);

  return (
    <div className="neon-card rounded-lg border border-white/10 p-4 sm:p-5">
      {/* ---- Summary row ---- */}
      <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-[0.7rem] uppercase tracking-label border rounded px-2 py-0.5 ${st.cls}`}>
              {BUSY.includes(machine.status) && <span className="inline-block w-1.5 h-1.5 rounded-full bg-neon-amber animate-pulse mr-1.5 align-middle" />}
              {st.text}
            </span>
            <Nickname machine={machine} onRenamed={onOpFinished} />
            <span className="text-xs text-slate-400 font-mono">{machine.instance_type}</span>
            {shape && <TierBadge shape={shape} />}
            {machine.display_driver === 'grid' && (
              <span className="text-[0.66rem] uppercase tracking-label text-neon-magenta border border-neon-magenta/60 bg-neon-magenta/10 rounded px-1.5 py-0.5 whitespace-nowrap"
                title="Experimental: NVIDIA GRID driver — screens up to 4096×2160 instead of 2560×1600">▣ big screen · experimental</span>
            )}
            <span className="text-xs text-slate-400">{PROVIDER_LABEL[machine.provider] || machine.provider} · {machine.region}{zone && zone !== machine.region ? ` · ${zone}` : ''}</span>
            {machine.spot
              ? <span className="text-[0.66rem] uppercase tracking-label text-neon-amber border border-neon-amber/40 rounded px-1.5">spot</span>
              : <span className="text-[0.66rem] uppercase tracking-label text-slate-400 border border-white/15 rounded px-1.5">on-demand</span>}
            {canSwitchNow && (
              <button type="button" disabled={busy} onClick={() => setConfirm('pricing')} className="text-[0.7rem] text-neon-cyan hover:underline disabled:opacity-40"
                title={machine.spot ? 'Full price, never reclaimed (e.g. for the first setup)' : 'Cheaper, but the cloud can reclaim it'}>
                ⇄ {machine.spot ? 'switch to on-demand' : 'switch to spot'}
              </button>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {st.hint}
            {name && <> · <span className="font-mono">{name}</span></>}
            {machine.game_title && <> · {machine.game_title}</>}
            {' · '}checked {timeAgo(machine.last_synced_at || machine.created_at)}
          </p>
          {!placeholderId && machine.status !== 'shelved' && (
            <div className="mt-2">
              <DiskMeter machineId={machine.id} status={machine.status} busy={busy}
                perGbMonth={sd && machine.disk_size_gb ? sd.diskMonthly / machine.disk_size_gb : undefined}
                onResize={(sizeGb) => onAction(machine, 'disk', { sizeGb })}
                onUpdateScript={machine.provider === 'gcp' ? (restart) => onAction(machine, 'update-script', { restart }) : undefined} />
            </div>
          )}
        </div>
        <div className="flex items-center gap-6 text-xs">
          <div>
            <p className="label">{machine.status === 'shelved' ? 'Restored cost' : 'Cost'}</p>
            <p className={`tabular-nums ${machine.status === 'running' ? 'text-neon-lime' : 'text-slate-400'}`}>≈{money(machine.cost_per_hour)}/h</p>
          </div>
          {sd && (
            <div title="Billed every month whether or not you play">
              <p className="label">Standing</p>
              <p className="tabular-nums text-slate-200">
                {machine.status === 'shelved' ? `${sd.shelfExact ? '' : '≤'}${money(sd.shelfMonthly || 0)}/mo` : ['failed', 'missing'].includes(machine.status) || placeholderId ? '—' : `${money(sd.diskMonthly)}/mo`}
              </p>
            </div>
          )}
          <div><p className="label">IP</p><p className="font-mono text-slate-200">{machine.ip_address || '—'}</p></div>
          {/* Which NVIDIA driver it runs: the standard one caps the screen at 2560×1600; "Big screen" (GRID) at 4096×2160. */}
          <div title={machine.display_driver === 'grid'
            ? 'Big screen (experimental): NVIDIA GRID driver — screens up to 4096×2160, e.g. a 3440×1440 ultrawide at full size.'
            : 'Standard NVIDIA datacenter driver — screens up to 2560×1600. Launch with “Big screen” for more.'}>
            <p className="label">Screen</p>
            {machine.display_driver === 'grid'
              ? <p className="text-neon-magenta tabular-nums">≤4096×2160 <span className="hidden sm:inline text-[0.64rem] uppercase tracking-label">big · exp</span></p>
              : <p className="text-slate-400 tabular-nums">≤2560×1600</p>}
          </div>
        </div>
        {/* ---- Actions that make sense for this state ---- */}
        <div className="flex flex-wrap gap-2">
          {machine.status === 'stopped' && (
            <>
              <button type="button" disabled={busy} onClick={() => onAction(machine, 'start')} className="btn-neon-lime text-xs disabled:opacity-40">Start</button>
              <button type="button" disabled={busy} onClick={() => setConfirm('shelve')} className="btn-neon text-xs disabled:opacity-40" title="Snapshot, then delete the machine and disk — much cheaper to keep">Shelve</button>
            </>
          )}
          {machine.status === 'shelved' && (
            <button type="button" disabled={busy} onClick={() => setConfirm('restore')} className="btn-neon-lime text-xs disabled:opacity-40">Restore</button>
          )}
          {machine.status === 'running' && (
            <button type="button" disabled={busy} onClick={() => setConfirm('stop')} className="btn-neon-pink text-xs disabled:opacity-40">Stop</button>
          )}
          {!placeholderId && (
            // Sync only reads the state, so it stays usable when a machine looks stuck mid-change.
            <button type="button" disabled={!!activeOp} onClick={() => onAction(machine, 'sync')} className="btn-neon text-xs disabled:opacity-40" title="Ask the cloud for the real state">Sync</button>
          )}
          <button type="button" disabled={busy} onClick={() => setConfirm('delete')} className="text-xs border border-red-600/50 text-red-400 hover:border-red-500 rounded px-3 py-1.5 disabled:opacity-40">Delete</button>
        </div>
      </div>

      {/* ---- Stuck mid-change with nothing running? Say so (the page also re-checks by itself). ---- */}
      {stale && (
        <p className="mt-3 rounded border border-neon-amber/30 bg-neon-amber/[0.04] px-3 py-2 text-xs text-neon-amber">
          ! Still “{machine.status}” and last confirmed with the cloud {timeAgo(machine.last_synced_at || machine.created_at)} — longer than this should take.
          Re-checking with the cloud automatically; press <strong>Sync</strong> to do it now. If Sync says it is stopped or running, you&apos;re all set.
        </p>
      )}

      {/* ---- Standing cost: what this machine costs while you aren't playing ---- */}
      {sd && machine.status === 'stopped' && (
        <div className="mt-3 rounded border border-neon-amber/25 bg-neon-amber/[0.04] px-3 py-2 text-xs text-slate-300 space-y-1.5">
          <p>
            <span className="text-neon-amber">Stopped{daysSince(machine.stopped_at) ? ` ${daysSince(machine.stopped_at)} day${daysSince(machine.stopped_at) === 1 ? '' : 's'}` : ''}:</span>{' '}
            no compute charge, but its {sd.diskGb} GB disk costs <span className="text-slate-100 tabular-nums">{money(sd.diskMonthly)}/month</span>, empty space included.
            Shelved it would be about <span className="text-slate-100 tabular-nums">{usdRange(sd.shelfEstimate.low, sd.shelfEstimate.high)}/month</span>{' '}
            (snapshots bill only the data stored: {money(sd.shelfEstimate.low)} for a fresh install, {money(sd.shelfEstimate.high)} if the disk is full).
          </p>
          <AutoShelvePicker value={autoShelve} saving={autoSaving} onChange={changeAutoShelve} />
        </div>
      )}
      {sd && machine.status === 'running' && (
        <p className="mt-2 text-[0.7rem] text-slate-500">
          When you stop, the {sd.diskGb} GB disk keeps costing {money(sd.diskMonthly)}/month; shelving cuts that to ≈{usdRange(sd.shelfEstimate.low, sd.shelfEstimate.high)}.{' '}
          <AutoShelvePicker value={autoShelve} saving={autoSaving} onChange={changeAutoShelve} inline />
        </p>
      )}
      {sd && machine.status === 'shelved' && (
        <div className="mt-3 rounded border border-neon-purple/30 bg-neon-purple/[0.04] px-3 py-2 text-xs text-slate-300">
          Shelved {machine.shelved_at ? timeAgo(machine.shelved_at) : ''}: only its snapshot is billed —{' '}
          <span className="text-slate-100 tabular-nums">{sd.shelfExact ? '' : 'at most '}{money(sd.shelfMonthly || 0)}/month</span>
          {sd.storedGb ? <> for {sd.storedGb} GB of data</> : <> (billed on the data stored, usually less)</>}, instead of {money(sd.diskMonthly)} for the disk.
          Restore brings it back with your games, settings, logins and Moonlight pairing.
        </div>
      )}

      {/* ---- Confirmations ---- */}
      {confirm === 'stop' && (
        <div className="mt-3 rounded border border-neon-pink/30 p-3 text-xs text-slate-300 space-y-2">
          <p>Stop this machine? Compute billing stops; the disk (and your games) are kept{sd ? ` — about ${money(sd.diskMonthly)}/month` : ''}. Anyone streaming will be disconnected.</p>
          <p className="text-slate-400">Not playing for a week or more? <strong className="text-slate-200">Stop &amp; shelve</strong> instead: it snapshots the disk and deletes it, so it costs {sd ? `≈${usdRange(sd.shelfEstimate.low, sd.shelfEstimate.high)}` : 'far less'}/month until you restore.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-neon-pink text-xs" onClick={() => { setConfirm(null); onAction(machine, 'stop'); }}>Stop</button>
            <button type="button" className="btn-neon text-xs" onClick={() => { setConfirm(null); onAction(machine, 'stop-shelve'); }}>Stop &amp; shelve</button>
            <button type="button" className="text-slate-400 hover:text-slate-200 px-2" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
      {confirm === 'shelve' && (
        <div className="mt-3 rounded border border-neon-cyan/30 p-3 text-xs text-slate-300 space-y-2">
          <p><strong className="text-slate-100">Shelve this machine?</strong></p>
          <ol className="list-decimal pl-4 space-y-0.5">
            <li>The disk is snapshotted (a few minutes; the first snapshot of a big disk can take up to ~30).</li>
            <li>Only once the cloud confirms the snapshot is complete, the machine and its disk are deleted. If anything goes wrong, nothing is deleted.</li>
            <li>Standing cost drops from {sd ? money(sd.diskMonthly) : 'the disk'}/month to ≈{sd ? `${usdRange(sd.shelfEstimate.low, sd.shelfEstimate.high)}` : 'a fraction'}/month.</li>
          </ol>
          <p className="text-slate-400">To play again, press Restore: it rebuilds the disk from the snapshot, which takes several minutes longer than Start. Games, settings, logins and Moonlight pairing are kept; the IP address changes.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-neon text-xs" onClick={() => { setConfirm(null); onAction(machine, 'shelve'); }}>Shelve it</button>
            <button type="button" className="text-slate-400 hover:text-slate-200 px-2" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
      {confirm === 'pricing' && (() => {
        const to = !machine.spot;
        const now = priceFor(machine.spot);
        const next = priceFor(to);
        return (
          <div className="mt-3 rounded border border-neon-cyan/30 p-3 text-xs text-slate-300 space-y-2">
            <p>
              <strong className="text-slate-100">Switch to {to ? 'spot' : 'on-demand'}?</strong>{' '}
              {next != null && <>≈{money(next)}/hour while running{now != null && <> (now ≈{money(now)})</>}. </>}
              {to
                ? 'Spot is much cheaper, but the cloud can reclaim it at short notice — fine for playing, risky during the first setup. The disk and games are kept when that happens.'
                : 'On-demand is full price and never reclaimed — the safe choice for the first setup or a long session. It uses your normal GPU quota, not the spot one.'}
            </p>
            <p className="text-slate-400">
              {machine.status === 'shelved' ? 'Applied when you restore it.'
                : machine.status === 'running' ? 'The cloud only switches a stopped machine: it is stopped, switched and started again (a couple of minutes; setup and games carry on).'
                : 'Switched in place (same disk); start it when you’re ready.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-neon text-xs" onClick={() => { setConfirm(null); onAction(machine, 'pricing', { spot: to }); }}>Switch to {to ? 'spot' : 'on-demand'}</button>
              <button type="button" className="text-slate-400 hover:text-slate-200 px-2" onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          </div>
        );
      })()}
      {confirm === 'restore' && (
        <div className="mt-3 rounded border border-neon-lime/30 p-3 text-xs text-slate-300 space-y-2">
          <p><strong className="text-slate-100">Restore this machine?</strong> A new machine is built from the snapshot (typically 5–15 minutes, then its quick start-up check). Billing then resumes at ≈{money(machine.cost_per_hour)}/hour while running, plus the disk.</p>
          {sd?.restoreAnyRegion && regions.length > 0 ? (
            <label className="block">
              <span className="text-slate-400">Region — this cloud can restore your games anywhere, handy when you travel:</span>
              <ThemedSelect className="mt-1" value={restoreRegion} onChange={setRestoreRegion} ariaLabel="Restore region"
                options={byDistance(regions, place).map((r) => ({
                  value: r.id, label: `${r.name} (${r.id})`, hint: r.id === machine.region ? 'where it was' : undefined,
                  aside: r.pingMs != null ? `~${r.pingMs} ms` : undefined,
                }))} />
            </label>
          ) : <p className="text-slate-400">It comes back in {machine.region} (this cloud restores snapshots only where they were taken).</p>}
          <div>
            <span className="text-slate-400">Pricing:</span>
            <div role="radiogroup" aria-label="Pricing" className="mt-1 inline-flex rounded border border-white/10 overflow-hidden ml-2">
              {[false, true].map((sp) => {
                const p = priceFor(sp, restoreRegion);
                return (
                  <button key={String(sp)} type="button" role="radio" aria-checked={restoreSpot === sp} onClick={() => setRestoreSpot(sp)}
                    className={`px-2.5 py-1 border-r last:border-r-0 border-white/10 ${restoreSpot === sp ? (sp ? 'bg-neon-amber/15 text-neon-amber' : 'bg-neon-cyan/15 text-neon-cyan') : 'text-slate-400 hover:text-slate-200'}`}>
                    {sp ? 'Spot' : 'On-demand'}{p != null && <span className="tabular-nums"> · {money(p)}/h</span>}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={keepSnapshot} onChange={(e) => setKeepSnapshot(e.target.checked)} className="mt-0.5" />
            <span>Keep the snapshot as a backup afterwards <span className="text-slate-500">(off = deleted once the machine is back, so you don&apos;t pay twice; {sd?.shelfMonthly ? `≈${money(sd.shelfMonthly)}/month` : 'a small monthly charge'} if kept)</span></span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-neon-lime text-xs" onClick={async () => {
              setConfirm(null);
              if (restoreSpot !== !!machine.spot) await onAction(machine, 'pricing', { spot: restoreSpot }); // shelved: recorded instantly
              await onAction(machine, 'restore', { region: restoreRegion, keepSnapshot });
            }}>Restore</button>
            <button type="button" className="text-slate-400 hover:text-slate-200 px-2" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
      {confirm === 'delete' && (
        <div className="mt-3 rounded border border-red-600/40 p-3 text-xs text-slate-300 space-y-2">
          {machine.status === 'shelved' ? (
            <p><strong className="text-red-400">Delete permanently?</strong> Its snapshot — the only copy of its installed games — is deleted at {PROVIDER_LABEL[machine.provider]}, and billing for it stops. This can&apos;t be undone.</p>
          ) : (
            <p>
              <strong className="text-red-400">Delete permanently?</strong> The machine AND its disk (installed games, saves not in the cloud) are destroyed
              at {PROVIDER_LABEL[machine.provider]}. This can&apos;t be undone. Snapshots you took are kept (see Costs → Standing costs).
              {machine.status === 'stopped' && <> Want to keep your games cheaply instead? <strong className="text-slate-200">Shelve</strong> it.</>}
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" className="text-xs border border-red-600 text-red-300 rounded px-3 py-1.5 hover:bg-red-950/40" onClick={() => { setConfirm(null); onAction(machine, 'delete'); }}>Yes, delete it</button>
            <button type="button" className="text-slate-400 hover:text-slate-200 px-2" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* ---- Live log of the action in progress ---- */}
      {activeOp && (
        <div className="mt-4">
          <OperationConsole operationId={activeOp} onFinished={onOpFinished} />
        </div>
      )}
      {!activeOp && machine.last_error && ['failed', 'unknown', 'missing'].includes(machine.status) && (
        <div className="mt-4"><FriendlyErrorCard friendly={machine.last_error} /></div>
      )}

      {/* ---- Tabs ---- */}
      <div className="mt-4 flex gap-1 border-b border-white/5">
        {(['connect', 'monitor', 'architecture', 'activity'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(tab === t ? null : t)}
            className={`px-3 py-1.5 text-[0.72rem] uppercase tracking-label border-b-2 -mb-px ${tab === t ? 'border-neon-cyan text-neon-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
          >
            {{ connect: 'Connect', monitor: 'Monitor', architecture: 'Architecture', activity: 'Activity' }[t]}
          </button>
        ))}
      </div>
      {tab === 'connect' && (
        <div className="pt-4">
          {machine.status === 'shelved'
            ? <p className="text-xs text-slate-500">Shelved — restore it to connect. Moonlight&apos;s pairing is kept; only the IP address changes.</p>
            : ['running', 'stopped', 'starting'].includes(machine.status)
            ? <MachineConnectionPanel machineId={machine.id} status={machine.status} quality={machine.streaming_quality} onStage={setStage} bigScreen={machine.display_driver === 'grid'}
                onResume={activeOp ? undefined : () => onAction(machine, 'resume-setup')} onStatusChange={onOpFinished}
                onResumeOnDemand={activeOp || !machine.spot || !PRICING_IN_PLACE.has(machine.provider) ? undefined : () => onAction(machine, 'pricing', { spot: false, start: true })} />
            : <p className="text-xs text-slate-500">Connection details appear once the machine exists and is running.</p>}
        </div>
      )}
      {tab === 'monitor' && (
        <div className="pt-4">
          {placeholderId || machine.status === 'shelved'
            ? <p className="text-xs text-slate-500">Telemetry appears once the machine exists and is running.</p>
            : <TelemetryPanel machineId={machine.id} status={machine.status} />}
        </div>
      )}
      {tab === 'architecture' && (
        <div className="pt-4">
          <ArchitectureDiagram machine={machine} setupStage={stage} />
        </div>
      )}
      {tab === 'activity' && (
        <div className="pt-4 space-y-2">
          {!history && <p className="text-xs text-slate-500 animate-pulse">&gt; loading…</p>}
          {history?.length === 0 && <p className="text-xs text-slate-500">No actions yet.</p>}
          {history?.map((op) => (
            <div key={op.id} className="rounded border border-white/5">
              <button type="button" onClick={() => setOpenOp(openOp === op.id ? null : op.id)} className="w-full text-left px-3 py-2 flex items-center gap-3 text-xs">
                <span className={op.status === 'succeeded' ? 'text-neon-lime' : op.status === 'failed' ? 'text-neon-pink' : 'text-neon-amber'}>
                  {op.status === 'succeeded' ? '✓' : op.status === 'failed' ? '✗' : '…'}
                </span>
                <span className="text-slate-200 flex-1">{op.title}</span>
                <span className="text-slate-500">{timeAgo(op.created_at)}</span>
              </button>
              {openOp === op.id && <div className="px-3 pb-3"><OperationConsole operationId={op.id} /></div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MachinesPageInner() {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [activeOps, setActiveOps] = useState<Record<string, string>>({}); // machineId → operationId
  const [actionError, setActionError] = useState<{ machineId: string; error: ApiError } | null>(null);
  const [recent, setRecent] = useState<OperationSummary[]>([]);
  const [showPlatform, setShowPlatform] = useState(false);
  // Regions per cloud, for "restore in another region" (clouds that allow it).
  const [regionsBy, setRegionsBy] = useState<Record<string, Region[]>>({});
  const [gpuOf, setGpuOf] = useState<Record<string, string>>({});
  const [shapeOf, setShapeOf] = useState<Record<string, ShapeInfo>>({});
  const [bigExtraOf, setBigExtraOf] = useState<Record<string, number>>({});
  // Regions this machine's GPU is offered in.
  const regionsFor = (m: Machine) => (regionsBy[m.provider] || []).filter((r) => !gpuOf[`${m.provider}:${m.instance_type}`] || r.gpus.includes(gpuOf[`${m.provider}:${m.instance_type}`]));
  useEffect(() => {
    apiFetch<{ providers: Array<{ provider: string; regions: Region[]; shapes: ShapeInfo[]; bigScreen?: { extraPerHour: number } }> }>('/machines/options')
      .then((o) => {
        setRegionsBy(Object.fromEntries(o.providers.map((p) => [p.provider, p.regions])));
        setGpuOf(Object.fromEntries(o.providers.flatMap((p) => p.shapes.map((sh) => [`${p.provider}:${sh.id}`, sh.gpuModel]))));
        setShapeOf(Object.fromEntries(o.providers.flatMap((p) => p.shapes.map((sh) => [`${p.provider}:${sh.id}`, sh]))));
        setBigExtraOf(Object.fromEntries(o.providers.map((p) => [p.provider, p.bigScreen?.extraPerHour || 0])));
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    try {
      const [list, ops] = await Promise.all([
        apiFetch<Machine[]>('/machines'),
        apiFetch<OperationSummary[]>('/operations?limit=12'),
      ]);
      setMachines(list);
      setRecent(ops);
      setLoadError(null);
      // Re-attach consoles for actions still running (e.g. after a page reload).
      setActiveOps((current) => {
        const next = { ...current };
        for (const op of ops) if (op.status === 'running' && op.machine_id && !next[op.machine_id]) next[op.machine_id] = op.id;
        return next;
      });
    } catch (e) {
      setLoadError(e as ApiError);
    }
  }, []);

  // Refresh fast while something is changing, slowly otherwise.
  const anyBusy = (machines || []).some((m) => BUSY.includes(m.status)) || Object.keys(activeOps).length > 0;
  useEffect(() => {
    load();
    const timer = setInterval(load, anyBusy ? 8000 : 30000);
    return () => clearInterval(timer);
  }, [load, anyBusy]);

  const runAction = async (machine: Machine, action: Action, body: Record<string, unknown> = {}) => {
    setActionError(null);
    try {
      // "Stop & shelve" is just Shelve: it stops the machine first by itself.
      const path = action === 'stop-shelve' ? 'shelve' : action;
      const res = await apiFetch<{ operationId: string | null }>(
        action === 'delete' ? `/machines/${machine.id}` : `/machines/${machine.id}/${path}`,
        { method: action === 'delete' ? 'DELETE' : 'POST', body: action === 'delete' ? undefined : body }
      );
      if (res.operationId) setActiveOps((ops) => ({ ...ops, [machine.id]: res.operationId! }));
      load();
    } catch (e) {
      setActionError({ machineId: machine.id, error: e as ApiError });
    }
  };

  // Auto-poll: a machine stuck mid-change gets one automatic Sync per page
  // view (the backend's 5-minute status check also catches it).
  const autoSynced = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const m of machines || []) {
      if (isStuck(m, activeOps[m.id] || null) && !autoSynced.current.has(m.id)) {
        autoSynced.current.add(m.id);
        runAction(m, 'sync');
      }
    }
  }, [machines]); // eslint-disable-line react-hooks/exhaustive-deps

  const finished = (machineId: string) => {
    // Leave the finished log visible a moment, then clear it and refresh.
    load();
    setTimeout(() => setActiveOps((ops) => { const next = { ...ops }; delete next[machineId]; return next; }), 15000);
  };

  const running = (machines || []).filter((m) => m.status === 'running');
  // Status first, then newest first. A failed launch with an active
  // operation (e.g. being retried or deleted) stays with the live ones.
  const RANK: Record<string, number> = { running: 0, creating: 1, starting: 1, stopping: 1, deleting: 1, shelving: 1, restoring: 1, stopped: 2, shelved: 3 };
  const isDead = (m: Machine) => ['failed', 'missing'].includes(m.status) && !activeOps[m.id];
  const byRank = (a: Machine, b: Machine) =>
    (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3) || new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  const sorted = {
    live: (machines || []).filter((m) => !isDead(m)).sort(byRank),
    failed: (machines || []).filter(isDead).sort(byRank),
  };
  const hourly = running.reduce((sum, m) => sum + m.cost_per_hour, 0);
  // Billed every month whether or not you play: disks of existing machines, snapshots of shelved ones.
  const standing = (machines || []).reduce((sum, m) => sum + (!m.standing ? 0
    : m.status === 'shelved' ? m.standing.shelfMonthly || 0
    : ['running', 'stopped', 'starting', 'stopping', 'unknown'].includes(m.status) && !/^(pending|shelved):/.test(m.instance_id) ? m.standing.diskMonthly : 0), 0);
  const idleDisks = (machines || []).filter((m) => m.status === 'stopped' && m.standing);
  const couldSave = idleDisks.reduce((s, m) => s + m.standing!.diskMonthly - m.standing!.shelfEstimate.high, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-xl font-bold neon-text mb-1 font-mono">[ MACHINES ]</h1>
          <p className="text-sm text-slate-400">
            {machines ? `${machines.length} machine${machines.length === 1 ? '' : 's'} · ${running.length} running` : 'Loading…'}
            {running.length > 0 && <> · <span className="text-neon-lime tabular-nums">≈{usd(hourly)}/hour</span> right now</>}
            {standing > 0 && <> · standing <Link href="/costs#standing" className="text-slate-200 tabular-nums hover:underline">≈{money(standing)}/month</Link></>}
          </p>
          {couldSave > 1 && (
            <p className="text-xs text-neon-amber mt-1">
              {idleDisks.length} stopped machine{idleDisks.length === 1 ? '' : 's'} keep{idleDisks.length === 1 ? 's' : ''} a full disk billed. Shelving would save at least {money(couldSave)}/month — see <Link href="/costs#standing" className="underline">Standing costs</Link>.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setShowPlatform((v) => !v)} className="btn-neon text-xs">{showPlatform ? 'Hide' : 'How it works'}</button>
          <button type="button" onClick={() => setLaunchOpen(true)} className="btn-neon-magenta">[ LAUNCH_MACHINE ]</button>
        </div>
      </div>

      {showPlatform && (
        <section className="neon-card rounded-lg border border-white/10 p-5">
          <h2 className="label mb-3">Platform architecture — what runs where</h2>
          <ArchitectureDiagram provider={machines?.[0]?.provider || 'gcp'} />
        </section>
      )}

      {loadError && <FriendlyErrorCard message={loadError.message} tip={loadError.tip} friendly={loadError.friendly} />}
      {actionError && (
        <div>
          <p className="text-xs text-slate-500 mb-1">Couldn&apos;t start that action:</p>
          <FriendlyErrorCard message={actionError.error.message} tip={actionError.error.tip} friendly={actionError.error.friendly} />
        </div>
      )}

      {machines && machines.length === 0 && (
        <div className="neon-card rounded-lg border border-white/10 p-8 text-center space-y-4">
          <p className="font-mono text-neon-lime">&gt; NO_MACHINES_YET</p>
          <p className="text-sm text-slate-400 max-w-lg mx-auto">
            A machine is a GPU computer in <strong>your own</strong> cloud account that you stream games from. First add your cloud keys on the{' '}
            <Link href="/settings" className="text-neon-cyan hover:underline">Config page</Link>, then launch one here.
          </p>
          <button type="button" onClick={() => setLaunchOpen(true)} className="btn-neon-magenta">[ LAUNCH_YOUR_FIRST_MACHINE ]</button>
        </div>
      )}

      {/* Usable machines first (running → busy → stopped), failed launches
          last and folded away; newest first within each group. */}
      <div className="space-y-4">
        {sorted.live.map((m) => (
          <MachineCard
            key={m.id}
            machine={m}
            activeOp={activeOps[m.id] || null}
            onAction={runAction}
            onOpFinished={() => finished(m.id)}
            regions={regionsFor(m)}
            shape={shapeOf[`${m.provider}:${m.instance_type}`]} bigExtra={bigExtraOf[m.provider]}
          />
        ))}
      </div>
      {sorted.failed.length > 0 && (
        <details className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2" open={sorted.live.length === 0}>
          <summary className="cursor-pointer text-sm text-slate-400">
            Failed launches ({sorted.failed.length}) <span className="text-xs text-slate-500">— nothing is running or billing for these; delete them to tidy up</span>
          </summary>
          <div className="mt-3 space-y-4">
            {sorted.failed.map((m) => (
              <MachineCard
                key={m.id}
                machine={m}
                activeOp={activeOps[m.id] || null}
                onAction={runAction}
                onOpFinished={() => finished(m.id)}
                regions={regionsFor(m)}
                shape={shapeOf[`${m.provider}:${m.instance_type}`]} bigExtra={bigExtraOf[m.provider]}
              />
            ))}
          </div>
        </details>
      )}

      {/* ---- Recent activity across all machines ---- */}
      {recent.length > 0 && (
        <section className="neon-card rounded-lg border border-white/10 p-5">
          <h2 className="label mb-3">Recent activity</h2>
          <ul className="divide-y divide-white/5">
            {recent.map((op) => (
              <li key={op.id} className="py-2 flex items-start gap-3 text-xs">
                <span className={op.status === 'succeeded' ? 'text-neon-lime' : op.status === 'failed' ? 'text-neon-pink' : 'text-neon-amber animate-pulse'}>
                  {op.status === 'succeeded' ? '✓' : op.status === 'failed' ? '✗' : '●'}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-slate-200">{op.title}</p>
                  <p className="text-slate-500 truncate">{op.status === 'failed' && op.error ? op.error.title : op.last_message}</p>
                </div>
                <span className="text-slate-500 flex-shrink-0">{timeAgo(op.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {launchOpen && <LaunchMachineModal onClose={() => { setLaunchOpen(false); load(); }} onLaunched={load} />}
    </div>
  );
}

export default function MachinesPage() {
  return (
    <RequireAuth>
      <MachinesPageInner />
    </RequireAuth>
  );
}
