'use client';

/**
 * ============================================================================
 * components/StandingCosts.tsx — WHAT YOU PAY WHILE YOU AREN'T PLAYING
 * ============================================================================
 *
 * Shown on the Costs page (#standing). Three parts:
 *   1. The total billed every month even with nothing running, split into
 *      disks / snapshots / other, and how much the advice below would save.
 *   2. Your options for a machine you aren't using — Stopped vs Shelved vs
 *      Deleted — priced per cloud for a typical 150 GB disk.
 *   3. Every item that bills while idle (GET /api/inventory/standing), worst
 *      first: leftovers, then things that could be cheaper, then fine ones,
 *      each with its one-click action (Shelve / delete a spare snapshot) or
 *      a link to the cloud console.
 * ============================================================================
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usd, usdRange } from '@/lib/money';
import { apiFetch, type ApiError } from '@/lib/auth';
import CloudLogo from '@/components/CloudLogo';

type Level = 'ok' | 'save' | 'waste';
interface Item {
  key: string; provider: string; region: string; kind: 'disk' | 'snapshot' | 'ip' | 'other';
  name: string; sizeGb?: number; monthlyCost: number;
  machineId?: string; machineLabel?: string; machineStatus?: string; stoppedDays?: number; autoShelveDays?: number | null;
  snapshotRecordId?: string; estimated?: boolean; consoleUrl?: string;
  advice: { level: Level; text: string; action?: 'shelve' | 'restore' | 'delete-snapshot' | 'console' | 'machine'; saving?: { low: number; high: number } };
}
interface Rate { provider: string; label: string; diskPerGbMonth: number; snapshotPerGbMonth: number; defaultDiskGb: number; restoreAnyRegion: boolean }
interface Report {
  items: Item[];
  errors: Array<{ provider: string; error: { title: string } }>;
  totals: { monthly: number; disks: number; snapshots: number; other: number; waste: number; savingLow: number; savingHigh: number };
  rates: Rate[];
}

const money = (n: number) => usd(n);
const KIND_LABEL = { disk: 'Disk', snapshot: 'Snapshot', ip: 'Public IP', other: 'Other' };
const GROUPS: Array<{ level: Level; title: string; blurb: string; cls: string }> = [
  { level: 'waste', title: 'Leftovers — paying for nothing', blurb: 'Not attached to anything the app manages. Delete them in the cloud console (link on each).', cls: 'border-neon-pink/40' },
  { level: 'save', title: 'Could be cheaper', blurb: 'Stopped machines keeping a full disk, and spare backups.', cls: 'border-neon-amber/40' },
  { level: 'ok', title: 'Fine as is', blurb: 'In use, or already the cheapest way to keep your games.', cls: 'border-white/10' },
];

export default function StandingCosts({ onTotal }: { onTotal?: (monthly: number) => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);        // item key being acted on
  const [confirm, setConfirm] = useState<string | null>(null);  // item key awaiting confirmation
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback((refresh = false) => {
    apiFetch<Report>(`/inventory/standing${refresh ? '?refresh=true' : ''}`)
      .then((r) => { setReport(r); setError(null); onTotal?.(r.totals.monthly); })
      .catch((e: ApiError) => setError(e?.message || 'Couldn’t work out your standing costs.'));
  }, [onTotal]);
  useEffect(() => { load(); }, [load]);

  const act = async (it: Item) => {
    setBusy(it.key); setConfirm(null); setNote(null);
    try {
      if (it.advice.action === 'shelve' && it.machineId) {
        await apiFetch(`/machines/${it.machineId}/shelve`, { method: 'POST', body: {} });
        setNote(`Shelving ${it.machineLabel} — follow it on the Machines page. The disk is deleted only after the snapshot completes.`);
      } else if (it.advice.action === 'delete-snapshot' && it.snapshotRecordId) {
        await apiFetch(`/snapshots/${it.snapshotRecordId}`, { method: 'DELETE' });
        setNote(`Snapshot deleted — ${money(it.monthlyCost)}/month less.`);
      }
      setTimeout(() => load(true), 1500);
    } catch (e) {
      setNote(`⚠ ${(e as ApiError)?.message || 'That didn’t work.'}`);
    } finally {
      setBusy(null);
    }
  };

  const t = report?.totals;
  return (
    <section id="standing" className="scroll-mt-4 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm tracking-label font-bold neon-text font-mono">[ STANDING_COSTS ]</h2>
          <p className="text-xs text-slate-400 max-w-2xl mt-0.5">Billed every month even when nothing is running: disks of stopped machines, snapshots, reserved IPs and leftovers. Read live from your clouds.</p>
        </div>
        <button type="button" onClick={() => load(true)} className="btn-neon text-xs">↻ Re-check clouds</button>
      </div>

      {error && <p className="text-sm text-neon-amber">⚠ {error}</p>}
      {report?.errors.map((e) => (
        <p key={e.provider} className="text-xs text-neon-amber">⚠ Couldn’t read {e.provider.toUpperCase()} ({e.error.title}) — its items are estimated from the app’s records.</p>
      ))}

      {/* ---- 1. Totals ---- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <Tile label="Standing, per month" value={t ? money(t.monthly) : '—'} sub="whether or not you play" strong />
        <Tile label="Disks" value={t ? money(t.disks) : '—'} sub="billed on full size, empty space included" />
        <Tile label="Snapshots" value={t ? money(t.snapshots) : '—'} sub="billed on data actually stored" />
        <Tile label="Could save" value={t ? (t.savingHigh <= 0 ? usd(0) : t.savingLow === t.savingHigh ? money(t.savingHigh) : `${usdRange(t.savingLow, t.savingHigh)}`) : '—'} sub={t && t.waste > 0 ? `incl. ${money(t.waste)} of leftovers` : 'per month, following the advice below'} warn={!!t && t.savingHigh > 0.5} />
      </div>

      {/* ---- 2. The options for a machine you aren't using ---- */}
      <details className="rounded-lg border border-white/10 bg-white/[0.02] p-3 sm:p-4" open>
        <summary className="cursor-pointer text-sm text-slate-200">Not playing for a while? Your options, and what each costs</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs min-w-[520px]">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-1 pr-3 font-normal">Option</th><th className="py-1 pr-3 font-normal">You pay</th>
                <th className="py-1 pr-3 font-normal">Back to playing</th><th className="py-1 font-normal">Games &amp; logins</th>
              </tr>
            </thead>
            <tbody className="text-slate-300 align-top">
              <tr className="border-t border-white/5"><td className="py-1.5 pr-3 text-slate-100">Running</td><td className="py-1.5 pr-3">By the hour, plus the disk</td><td className="py-1.5 pr-3">Now</td><td className="py-1.5">Kept</td></tr>
              <tr className="border-t border-white/5"><td className="py-1.5 pr-3 text-slate-100">Stopped</td><td className="py-1.5 pr-3">The whole disk, every month</td><td className="py-1.5 pr-3">Start: 1–2 min</td><td className="py-1.5">Kept</td></tr>
              <tr className="border-t border-white/5"><td className="py-1.5 pr-3 text-neon-cyan">Shelved</td><td className="py-1.5 pr-3">A snapshot: only the data stored, at a lower rate</td><td className="py-1.5 pr-3">Restore: ~5–15 min, then a quick start-up check</td><td className="py-1.5">Kept (IP address changes)</td></tr>
              <tr className="border-t border-white/5"><td className="py-1.5 pr-3 text-slate-100">Deleted</td><td className="py-1.5 pr-3">Nothing</td><td className="py-1.5 pr-3">New machine: 20–35 min setup</td><td className="py-1.5">Gone — reinstall and log in again</td></tr>
            </tbody>
          </table>
        </div>
        {report && (
          <div className="mt-3 overflow-x-auto">
            <p className="label mb-1">Per month for a typical 150 GB machine</p>
            <table className="w-full text-xs tabular-nums min-w-[420px]">
              <thead><tr className="text-left text-slate-500"><th className="py-1 pr-3 font-normal">Cloud</th><th className="py-1 pr-3 font-normal text-right">Stopped</th><th className="py-1 pr-3 font-normal text-right">Shelved*</th><th className="py-1 font-normal">Restore in another region?</th></tr></thead>
              <tbody className="text-slate-300">
                {report.rates.map((r) => (
                  <tr key={r.provider} className="border-t border-white/5">
                    <td className="py-1.5 pr-3"><span className="inline-flex items-center gap-1.5"><CloudLogo provider={r.provider} size={14} />{r.label}</span></td>
                    <td className="py-1.5 pr-3 text-right">{money(150 * r.diskPerGbMonth)}</td>
                    <td className="py-1.5 pr-3 text-right text-neon-cyan">{usdRange(30 * r.snapshotPerGbMonth, 150 * r.snapshotPerGbMonth)}</td>
                    <td className="py-1.5">{r.restoreAnyRegion ? 'Yes — shelve at home, restore where you travel' : 'No — same region only'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[0.72rem] text-slate-500 mt-1">* A fresh install stores about 30 GB; the upper figure is a completely full disk. Estimates from list prices.</p>
          </div>
        )}
        <ul className="mt-3 space-y-1 text-xs text-slate-300 list-disc pl-4">
          <li><strong className="text-slate-100">Auto-stop</strong> (on every launch, 15 min idle) ends the hourly bill when you forget.</li>
          <li><strong className="text-slate-100">Auto-shelve</strong> (per machine, e.g. after 7 days stopped) ends the disk bill when you stop playing for a while. Set it on each machine card.</li>
          <li><strong className="text-slate-100">Right-size the disk</strong> at launch: disks bill their full size. Every extra 50 GB costs {report ? money(50 * Math.max(...report.rates.map((r) => r.diskPerGbMonth))) : '≈USD 5'}/month or so, stopped or not.</li>
          <li><strong className="text-slate-100">Don’t keep spare backups</strong> of machines that still have their disk — that’s paying twice.</li>
          <li><strong className="text-slate-100">Check for leftovers</strong> after deleting things in a cloud console yourself; they show up in red below and on the <Link href="/map" className="text-neon-cyan hover:underline">Map</Link>.</li>
        </ul>
      </details>

      {note && <p className="text-xs text-slate-300">{note}</p>}

      {/* ---- 3. Every item, worst first ---- */}
      {!report ? (
        <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; ASKING_YOUR_CLOUDS…</p>
      ) : report.items.length === 0 ? (
        <p className="text-xs text-slate-500">Nothing is billing while idle. 🎉</p>
      ) : GROUPS.map((g) => {
        const list = report.items.filter((i) => i.advice.level === g.level);
        if (!list.length) return null;
        return (
          <div key={g.level} className="space-y-1.5">
            <p className="text-xs"><span className={g.level === 'waste' ? 'text-neon-pink' : g.level === 'save' ? 'text-neon-amber' : 'text-slate-300'}>{g.title}</span>
              <span className="text-slate-500"> · {money(list.reduce((s, i) => s + i.monthlyCost, 0))}/month · {g.blurb}</span></p>
            <ul className="space-y-1.5">
              {list.map((it) => (
                <li key={it.key} className={`rounded border ${g.cls} bg-white/[0.02] px-3 py-2`}>
                  <div className="flex items-start gap-2.5">
                    <CloudLogo provider={it.provider} size={18} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-slate-100 leading-tight">
                        {it.machineLabel || it.name}
                        <span className="ml-1.5 align-middle text-[0.64rem] uppercase tracking-label rounded border border-white/15 text-slate-400 px-1">{KIND_LABEL[it.kind]}</span>
                        {it.estimated && <span className="ml-1 align-middle text-[0.64rem] text-slate-500">(estimated)</span>}
                      </p>
                      <p className="text-[0.72rem] text-slate-500 truncate">{it.region}{it.sizeGb ? ` · ${it.sizeGb} GB` : ''}{it.machineLabel && it.name !== it.machineLabel ? ` · ${it.name}` : ''}</p>
                      <p className="text-xs text-slate-300 mt-1">{it.advice.text}{it.advice.saving && it.advice.level === 'save' ? <> <span className="text-neon-amber whitespace-nowrap">Save {it.advice.saving.low === it.advice.saving.high ? money(it.advice.saving.low) : `${usdRange(it.advice.saving.low, it.advice.saving.high)}`}/month.</span></> : null}</p>
                      {confirm === it.key && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                          <span className="text-slate-300">{it.advice.action === 'shelve' ? 'Snapshot the disk, then delete the machine and disk?' : 'Delete this snapshot permanently?'}</span>
                          <button type="button" className="btn-neon text-xs" onClick={() => act(it)}>Yes</button>
                          <button type="button" className="text-slate-400 hover:text-slate-200" onClick={() => setConfirm(null)}>Cancel</button>
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 text-right space-y-1">
                      <p className="text-sm text-slate-100 tabular-nums">{money(it.monthlyCost)}<span className="text-slate-500 text-xs">/mo</span></p>
                      {it.advice.action === 'shelve' && it.machineStatus === 'stopped' && (
                        <button type="button" disabled={busy === it.key} onClick={() => setConfirm(it.key)} className="btn-neon text-[0.72rem] px-2 py-1 disabled:opacity-40">Shelve</button>
                      )}
                      {it.advice.action === 'delete-snapshot' && it.snapshotRecordId && (
                        <button type="button" disabled={busy === it.key} onClick={() => setConfirm(it.key)} className="text-[0.72rem] border border-red-600/50 text-red-400 hover:border-red-500 rounded px-2 py-1 disabled:opacity-40">Delete</button>
                      )}
                      {it.advice.action === 'restore' && <Link href="/machines" className="block text-[0.72rem] text-neon-cyan hover:underline">Restore →</Link>}
                      {it.advice.action === 'console' && it.consoleUrl && <a href={it.consoleUrl} target="_blank" rel="noreferrer" className="block text-[0.72rem] text-neon-cyan hover:underline">Console ↗</a>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function Tile({ label, value, sub, strong, warn }: { label: string; value: string; sub: string; strong?: boolean; warn?: boolean }) {
  return (
    <div className={`rounded border px-3 py-2.5 ${warn ? 'border-neon-amber/40 bg-neon-amber/[0.04]' : 'border-white/10 bg-white/[0.02]'}`}>
      <p className="label">{label}</p>
      <p className={`text-lg tabular-nums mt-0.5 ${warn ? 'text-neon-amber' : strong ? 'text-slate-50' : 'text-slate-100'}`}>{value}</p>
      <p className="text-[0.72rem] text-slate-500 mt-0.5 leading-snug">{sub}</p>
    </div>
  );
}
