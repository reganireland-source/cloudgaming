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

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RequireAuth } from '@/components/AuthProvider';
import { apiFetch, ApiError, type FriendlyError } from '@/lib/auth';
import LaunchMachineModal from '@/components/LaunchMachineModal';
import OperationConsole from '@/components/OperationConsole';
import FriendlyErrorCard from '@/components/FriendlyErrorCard';
import MachineConnectionPanel, { type ConnectionInfo } from '@/components/MachineConnectionPanel';
import ArchitectureDiagram from '@/components/ArchitectureDiagram';

interface Machine {
  id: string;
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
}

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
const BUSY = ['creating', 'starting', 'stopping', 'deleting'];

/** Colour + wording for each machine state. */
function statusStyle(status: string): { text: string; cls: string; hint: string } {
  switch (status) {
    case 'running': return { text: 'running', cls: 'border-neon-lime/60 text-neon-lime', hint: 'Billing by the hour.' };
    case 'stopped': return { text: 'stopped', cls: 'border-white/20 text-slate-400', hint: 'No compute charge; the disk is still billed monthly.' };
    case 'creating': return { text: 'creating', cls: 'border-neon-amber/60 text-neon-amber', hint: 'Being created at the cloud…' };
    case 'starting': return { text: 'starting', cls: 'border-neon-amber/60 text-neon-amber', hint: 'Powering on…' };
    case 'stopping': return { text: 'stopping', cls: 'border-neon-amber/60 text-neon-amber', hint: 'Powering off…' };
    case 'deleting': return { text: 'deleting', cls: 'border-neon-amber/60 text-neon-amber', hint: 'Being destroyed…' };
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

function MachineCard({
  machine, activeOp, onAction, onOpFinished,
}: {
  machine: Machine;
  activeOp: string | null;
  onAction: (machine: Machine, action: 'start' | 'stop' | 'stop-snapshot' | 'sync' | 'delete') => void;
  onOpFinished: () => void;
}) {
  const [tab, setTab] = useState<'connect' | 'architecture' | 'activity' | null>(machine.status === 'running' ? 'connect' : null);
  const [confirm, setConfirm] = useState<'stop' | 'delete' | null>(null);
  const [stage, setStage] = useState<ConnectionInfo['setup']['current']>(null);
  const [history, setHistory] = useState<OperationSummary[] | null>(null);
  const [openOp, setOpenOp] = useState<string | null>(null);
  const st = statusStyle(machine.status);
  const busy = BUSY.includes(machine.status) || !!activeOp;
  const [zone, name] = machine.instance_id.startsWith('pending:') ? ['', ''] : machine.instance_id.split('/');

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
            <span className={`text-[0.66rem] uppercase tracking-label border rounded px-2 py-0.5 ${st.cls}`}>
              {BUSY.includes(machine.status) && <span className="inline-block w-1.5 h-1.5 rounded-full bg-neon-amber animate-pulse mr-1.5 align-middle" />}
              {st.text}
            </span>
            <span className="text-sm font-semibold text-slate-100">{machine.instance_type}</span>
            <span className="text-xs text-slate-400">{PROVIDER_LABEL[machine.provider] || machine.provider} · {machine.region}{zone && zone !== machine.region ? ` · ${zone}` : ''}</span>
            {machine.spot && <span className="text-[0.62rem] uppercase tracking-label text-neon-amber border border-neon-amber/40 rounded px-1.5">spot</span>}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {st.hint}
            {name && <> · <span className="font-mono">{name}</span></>}
            {machine.game_title && <> · {machine.game_title}</>}
            {' · '}checked {timeAgo(machine.last_synced_at || machine.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-6 text-xs">
          <div><p className="label">Cost</p><p className="text-neon-lime tabular-nums">≈${machine.cost_per_hour.toFixed(2)}/h</p></div>
          <div><p className="label">IP</p><p className="font-mono text-slate-200">{machine.ip_address || '—'}</p></div>
        </div>
        {/* ---- Actions that make sense for this state ---- */}
        <div className="flex flex-wrap gap-2">
          {machine.status === 'stopped' && (
            <button type="button" disabled={busy} onClick={() => onAction(machine, 'start')} className="btn-neon-lime text-xs disabled:opacity-40">Start</button>
          )}
          {machine.status === 'running' && (
            <button type="button" disabled={busy} onClick={() => setConfirm('stop')} className="btn-neon-pink text-xs disabled:opacity-40">Stop</button>
          )}
          {!machine.instance_id.startsWith('pending:') && (
            <button type="button" disabled={busy} onClick={() => onAction(machine, 'sync')} className="btn-neon text-xs disabled:opacity-40" title="Ask the cloud for the real state">Sync</button>
          )}
          <button type="button" disabled={busy} onClick={() => setConfirm('delete')} className="text-xs border border-red-600/50 text-red-400 hover:border-red-500 rounded px-3 py-1.5 disabled:opacity-40">Delete</button>
        </div>
      </div>

      {/* ---- Confirmations ---- */}
      {confirm === 'stop' && (
        <div className="mt-3 rounded border border-neon-pink/30 p-3 text-xs text-slate-300 space-y-2">
          <p>Stop this machine? Compute billing stops; the disk (and your games) are kept. Anyone streaming will be disconnected.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-neon-pink text-xs" onClick={() => { setConfirm(null); onAction(machine, 'stop'); }}>Stop</button>
            <button type="button" className="btn-neon text-xs" onClick={() => { setConfirm(null); onAction(machine, 'stop-snapshot'); }}>Snapshot, then stop</button>
            <button type="button" className="text-slate-400 hover:text-slate-200 px-2" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
      {confirm === 'delete' && (
        <div className="mt-3 rounded border border-red-600/40 p-3 text-xs text-slate-300 space-y-2">
          <p>
            <strong className="text-red-400">Delete permanently?</strong> The machine AND its disk (installed games, saves not in the cloud) are destroyed
            at {PROVIDER_LABEL[machine.provider]}. This can&apos;t be undone. Snapshots you took are kept.
          </p>
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
        {(['connect', 'architecture', 'activity'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(tab === t ? null : t)}
            className={`px-3 py-1.5 text-[0.68rem] uppercase tracking-label border-b-2 -mb-px ${tab === t ? 'border-neon-cyan text-neon-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
          >
            {{ connect: 'Connect', architecture: 'Architecture', activity: 'Activity' }[t]}
          </button>
        ))}
      </div>
      {tab === 'connect' && (
        <div className="pt-4">
          {['running', 'stopped', 'starting'].includes(machine.status)
            ? <MachineConnectionPanel machineId={machine.id} status={machine.status} onStage={setStage} />
            : <p className="text-xs text-slate-500">Connection details appear once the machine exists and is running.</p>}
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

  const runAction = async (machine: Machine, action: 'start' | 'stop' | 'stop-snapshot' | 'sync' | 'delete') => {
    setActionError(null);
    try {
      const res = await apiFetch<{ operationId: string | null }>(
        action === 'delete' ? `/machines/${machine.id}` : `/machines/${machine.id}/${action === 'stop-snapshot' ? 'stop' : action}`,
        { method: action === 'delete' ? 'DELETE' : 'POST', body: action === 'stop-snapshot' ? { snapshot: true } : action === 'delete' ? undefined : {} }
      );
      if (res.operationId) setActiveOps((ops) => ({ ...ops, [machine.id]: res.operationId! }));
      load();
    } catch (e) {
      setActionError({ machineId: machine.id, error: e as ApiError });
    }
  };

  const finished = (machineId: string) => {
    // Leave the finished log visible a moment, then clear it and refresh.
    load();
    setTimeout(() => setActiveOps((ops) => { const next = { ...ops }; delete next[machineId]; return next; }), 15000);
  };

  const running = (machines || []).filter((m) => m.status === 'running');
  const hourly = running.reduce((sum, m) => sum + m.cost_per_hour, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-xl font-bold neon-text mb-1 font-mono">[ MACHINES ]</h1>
          <p className="text-sm text-slate-400">
            {machines ? `${machines.length} machine${machines.length === 1 ? '' : 's'} · ${running.length} running` : 'Loading…'}
            {running.length > 0 && <> · <span className="text-neon-lime tabular-nums">≈${hourly.toFixed(2)}/hour</span> right now</>}
          </p>
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

      <div className="space-y-4">
        {machines?.map((m) => (
          <MachineCard
            key={m.id}
            machine={m}
            activeOp={activeOps[m.id] || null}
            onAction={runAction}
            onOpFinished={() => finished(m.id)}
          />
        ))}
      </div>

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
