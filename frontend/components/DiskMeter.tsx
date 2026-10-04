'use client';

/**
 * components/DiskMeter.tsx — HOW FULL IS THE MACHINE'S DISK (AND MAKE IT BIGGER)
 *
 * Reads GET /api/machines/:id/disk: the usage the machine reports every 5
 * minutes on its serial console (backend caches it 5 minutes), shown as a
 * bar with GB and %. The full version (Machines page) has "Enlarge": the
 * cloud grows the disk in place — games and settings untouched — and the
 * machine grows its filesystem into the new space by itself. Disks can only
 * grow. The compact version (Dashboard) is the bar alone.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/auth';

interface DiskInfo {
  sizeGb: number;
  usage: { usedGb: number; totalGb: number; percent: number; at: string | null } | null;
  note?: string; canResize: boolean; resizeWhileRunning: boolean; maxGb: number;
}

const level = (pct: number) =>
  pct >= 90 ? { bar: 'bg-neon-pink', text: 'text-neon-pink', word: 'almost full' }
  : pct >= 75 ? { bar: 'bg-neon-amber', text: 'text-neon-amber', word: 'filling up' }
  : { bar: 'bg-neon-lime', text: 'text-neon-lime', word: '' };
const PRESETS = [50, 100, 250];

export default function DiskMeter({ machineId, status, compact = false, perGbMonth, busy = false, onResize, onUpdateScript }: {
  machineId: string; status: string; compact?: boolean;
  /** USD per GB-month, to price the bigger disk. */
  perGbMonth?: number;
  busy?: boolean;
  /** Starts the resize (the parent shows its operation log). */
  onResize?: (sizeGb: number) => void;
  /** Google: write the current on-machine script to an older machine so it starts reporting. */
  onUpdateScript?: (restart: boolean) => void;
}) {
  const [info, setInfo] = useState<DiskInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(0);
  const load = useCallback((refresh = false) => {
    apiFetch<DiskInfo>(`/machines/${machineId}/disk${refresh ? '?refresh=true' : ''}`).then(setInfo).catch(() => setInfo(null));
  }, [machineId]);
  useEffect(() => { if (!['shelved', 'terminated', 'deleting'].includes(status)) load(); }, [load, status]);

  if (!info) return null;
  const u = info.usage;
  const size = u ? Math.max(info.sizeGb, Math.round(u.totalGb)) : info.sizeGb;
  const lv = u ? level(u.percent) : null;
  const ago = u?.at ? Math.max(0, Math.round((Date.now() - new Date(u.at).getTime()) / 60000)) : null;

  const bar = (
    <div className="flex items-center gap-2 min-w-0" title={u ? `${u.usedGb} GB used of ${u.totalGb} GB${ago != null ? ` · reported ${ago} min ago` : ''}` : info.note}>
      <span className="text-[0.66rem] uppercase tracking-label text-slate-500 shrink-0">Disk</span>
      <span className="relative h-1.5 flex-1 min-w-[3rem] rounded-full bg-white/10 overflow-hidden" role="meter" aria-label="Disk used"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={u?.percent ?? undefined}>
        {u && <span className={`absolute inset-y-0 left-0 rounded-full ${lv!.bar}`} style={{ width: `${Math.min(100, u.percent)}%` }} />}
      </span>
      <span className={`text-[0.7rem] tabular-nums shrink-0 ${lv ? lv.text : 'text-slate-500'}`}>
        {u ? <>{u.usedGb.toFixed(0)}/{u.totalGb.toFixed(0)} GB · {u.percent}%{lv!.word ? ` · ${lv!.word}` : ''}</> : `${size} GB · usage not reported`}
      </span>
    </div>
  );
  if (compact) return bar;

  const min = size + 1;
  const pick = target || size + 100;
  const valid = pick > size && pick <= info.maxGb;
  const blocked = !info.resizeWhileRunning && status !== 'stopped';
  return (
    <div className="space-y-1.5 max-w-xl">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">{bar}</div>
        {info.canResize && onResize && (
          <button type="button" disabled={busy} onClick={() => { setOpen((v) => !v); setTarget(0); }}
            className="text-[0.7rem] text-neon-cyan hover:underline disabled:opacity-40 shrink-0">＋ Enlarge</button>
        )}
      </div>
      {!u && info.note && <p className="text-[0.66rem] text-slate-500">{info.note}</p>}
      {!u && onUpdateScript && ['running', 'stopped'].includes(status) && (
        <div className="rounded border border-white/10 bg-white/[0.02] p-2 text-[0.7rem] text-slate-400 space-y-1.5">
          <p>Launched before disk reporting existed? Update its on-machine script — games, settings and login stay the same; finished setup steps are skipped.</p>
          <div className="flex flex-wrap gap-2">
            {status === 'running' && (
              <button type="button" disabled={busy} onClick={() => { onUpdateScript(true); setTimeout(() => load(true), 240_000); }} className="btn-neon text-[0.7rem] px-2 py-1 disabled:opacity-40"
                title="Restarts the machine (1–3 minutes) — don't do it mid-game">Update &amp; restart now</button>
            )}
            <button type="button" disabled={busy} onClick={() => onUpdateScript(false)} className="text-neon-cyan hover:underline disabled:opacity-40">
              {status === 'running' ? 'Update, apply at next restart' : 'Update (applies at next start)'}
            </button>
          </div>
        </div>
      )}
      {open && (
        <div className="rounded border border-neon-cyan/30 bg-neon-cyan/[0.04] p-2.5 space-y-2 text-xs text-slate-300">
          <p>Grow the disk from {size} GB — games and settings stay, no rebuild. Disks can only grow, never shrink.</p>
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => (
              <button key={p} type="button" onClick={() => setTarget(size + p)}
                className={`rounded border px-2 py-0.5 tabular-nums ${pick === size + p ? 'border-neon-cyan text-neon-cyan' : 'border-white/15 text-slate-300 hover:border-white/30'}`}>
                +{p} → {size + p} GB
              </button>
            ))}
            <label className="inline-flex items-center gap-1">
              <input type="number" min={min} max={info.maxGb} step={10} value={pick} onChange={(e) => setTarget(Number(e.target.value))}
                className="w-20 bg-cyber-darker border border-white/15 rounded px-1.5 py-0.5 tabular-nums" aria-label="New size in GB" /> GB
            </label>
          </div>
          {perGbMonth ? (
            <p className="text-slate-400 tabular-nums">≈ USD {(pick * perGbMonth).toFixed(2)}/month for the disk (now {(size * perGbMonth).toFixed(2)}), billed even while stopped.</p>
          ) : null}
          {blocked ? (
            <p className="text-neon-amber">Azure enlarges a disk only while the machine is stopped — stop it first.</p>
          ) : (
            <p className="text-slate-500">{status === 'running'
              ? 'The cloud grows it while you play; the machine starts using the space within about 5 minutes. (Machines launched before this feature: after their next restart.)'
              : 'The new space is used from the next start.'}</p>
          )}
          <div className="flex gap-2">
            <button type="button" disabled={!valid || blocked || busy} className="btn-neon text-xs disabled:opacity-40"
              onClick={() => { setOpen(false); onResize!(pick); setTimeout(() => load(true), 60_000); }}>
              Enlarge to {pick} GB
            </button>
            <button type="button" className="text-xs text-slate-400 hover:text-slate-200" onClick={() => setOpen(false)}>Cancel</button>
          </div>
          {!valid && <p className="text-neon-amber">Pick {min}–{info.maxGb} GB.</p>}
        </div>
      )}
    </div>
  );
}
