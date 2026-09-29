'use client';

/**
 * ============================================================================
 * frontend/components/LaunchMachineModal.tsx — "LAUNCH A GAMING MACHINE" FORM
 * ============================================================================
 *
 * A pop-up form with every choice needed to launch, fed by the backend's
 * catalog (GET /api/machines/options):
 *   cloud → region → machine size → disk → spot? → game → quality
 * It shows the estimated price as you choose, and explains up front if a
 * cloud can't be used yet (no keys added, last check failed, or not built).
 *
 * On "Launch" it POSTs /api/machines. The backend answers immediately with
 * an operation id, and the form turns into the live OperationConsole so you
 * can watch the machine being created, step by step.
 * ============================================================================
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/auth';
import OperationConsole from './OperationConsole';
import FriendlyErrorCard from './FriendlyErrorCard';
import { ACCESS_STYLE, fetchRegionAccess, indexAccess, statusFor, type RegionAccess } from '@/lib/regionAccess';

interface Region { id: string; name: string; gpus: string[]; egressPerGb: number }
interface Shape {
  id: string; label: string; gpuModel: string; vcpus: number; memoryGb: number; bestFor: string;
  prices: Record<string, {
    onDemand: number; spot: number | null;
    // Spot detail (src/services/SpotPriceService.ts): live where the cloud publishes it.
    spotDiscountPct?: number | null; spotSource?: 'live' | 'fixed' | 'estimate' | null;
    spotInterruption?: { label: string; level: number } | null;
  }>;
}
interface ProviderOption {
  provider: string; label: string; configured: boolean; lastCheckOk: boolean | null; lastCheckSummary: string | null;
  available: boolean; supportsSpot: boolean; spotLabel: string; spotOnReclaim?: string; defaultRegion: string; defaultDiskGb: number;
  minDiskGb: number; diskPerGbMonth: number; snapshotPerGbMonth: number; priceNote: string; regions: Region[]; shapes: Shape[];
  bigScreen?: { available: boolean; extraPerHour: number; note: string };
}
interface Options { providers: ProviderOption[]; games: Array<{ title: string }>; qualities: string[] }

const QUALITY_HINT: Record<string, string> = {
  budget: '720p30 · ~1.4 GB/hour of data',
  good: '1080p60 · ~3.6 GB/hour',
  high: '1440p60 · ~5.4 GB/hour',
  ultra: '4K60 · ~9 GB/hour',
};

/** Pre-filled choices, e.g. from a Recon recommendation. Applied once, when the form opens. */
export interface LaunchPreset { provider: string; region: string; shapeId: string; quality?: string; game?: string; spot?: boolean }

export default function LaunchMachineModal({ onClose, onLaunched, preset }: { onClose: () => void; onLaunched: () => void; preset?: LaunchPreset }) {
  const [options, setOptions] = useState<Options | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [provider, setProvider] = useState('');
  const [region, setRegion] = useState('');
  const [shapeId, setShapeId] = useState('');
  const [diskGb, setDiskGb] = useState(150);
  const [spot, setSpot] = useState(false);
  const [bigScreen, setBigScreen] = useState(false); // EXPERIMENTAL GRID driver
  const [game, setGame] = useState(preset?.game || '');
  const [quality, setQuality] = useState(preset?.quality || 'high');
  // The preset's region/size/spot must survive the "cloud changed → reset
  // to defaults" effect below, which runs once the cloud list arrives.
  const presetPending = useRef(!!preset);
  const presetShape = useRef<string | null>(preset?.shapeId || null);
  const [autoStop, setAutoStop] = useState(15); // minutes without streaming before the machine shuts down; 0 = off
  const [autoShelve, setAutoShelve] = useState(7); // days stopped before it's shelved automatically; 0 = off
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  // Quota / region status per region (a hint, not a gate: it can be up to
  // 10 minutes old, and the launch itself says exactly what failed).
  const [access, setAccess] = useState<Record<string, RegionAccess>>({});
  useEffect(() => { fetchRegionAccess().then((r) => setAccess(indexAccess(r))).catch(() => undefined); }, []);

  useEffect(() => {
    apiFetch<Options>('/machines/options')
      .then((o) => {
        setOptions(o);
        // Pre-select the first cloud that's ready to use.
        const wanted = preset && o.providers.find((p) => p.provider === preset.provider);
        const ready = wanted || o.providers.find((p) => p.configured && p.available) || o.providers.find((p) => p.available);
        if (ready) setProvider(ready.provider);
      })
      .catch((e) => setLoadError(e));
  }, []);

  const current = options?.providers.find((p) => p.provider === provider);

  // When the cloud changes, reset region/size/disk to that cloud's defaults.
  useEffect(() => {
    if (!current) return;
    setDiskGb(current.defaultDiskGb);
    if (presetPending.current && preset && preset.provider === current.provider && current.regions.some((r) => r.id === preset.region)) {
      presetPending.current = false;
      setRegion(preset.region);
      setSpot(!!preset.spot && current.supportsSpot);
      return;
    }
    setRegion(current.regions.some((r) => r.id === current.defaultRegion) ? current.defaultRegion : current.regions[0]?.id || '');
    setSpot(false);
  }, [current?.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const regionInfo = current?.regions.find((r) => r.id === region);
  const shapesHere = useMemo(
    () => (current?.shapes || []).filter((s) => regionInfo?.gpus.includes(s.gpuModel)),
    [current, regionInfo]
  );
  // Keep the chosen size valid for the region.
  useEffect(() => {
    if (presetShape.current && shapesHere.some((s) => s.id === presetShape.current)) {
      setShapeId(presetShape.current);   // the preset's size, once its region is in place
      presetShape.current = null;
      return;
    }
    if (!shapesHere.some((s) => s.id === shapeId)) setShapeId(shapesHere[0]?.id || '');
  }, [shapesHere, shapeId]);

  const shape = shapesHere.find((s) => s.id === shapeId);
  const price = shape?.prices[region];
  const bigOk = !!current?.bigScreen?.available;
  const hourly = (spot && price?.spot != null ? price.spot : price?.onDemand || 0) + (bigScreen && bigOk ? current!.bigScreen!.extraPerHour : 0);
  const diskMonthly = current ? diskGb * current.diskPerGbMonth : 0;
  // Shelved: snapshot billed on data stored — ~30 GB fresh install … full disk.
  const shelfLow = current ? Math.min(30, diskGb) * current.snapshotPerGbMonth : 0;
  const shelfHigh = current ? diskGb * current.snapshotPerGbMonth : 0;

  const blocker = !current
    ? null
    : !current.available
    ? `${current.label} launching isn't available yet.`
    : !current.configured
    ? `Add your ${current.label} keys on the Config page first.`
    : null;

  const launch = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await apiFetch<{ machineId: string; operationId: string }>('/machines', {
        method: 'POST',
        body: { provider, region, shapeId, diskSizeGb: diskGb, spot, gameTitle: game || undefined, quality, autoStopMinutes: autoStop, autoShelveDays: autoShelve || null, bigScreen: bigScreen && bigOk },
      });
      setOperationId(res.operationId);
      onLaunched(); // show the new "creating" machine in the list straight away
    } catch (e) {
      setSubmitError(e as ApiError);
    } finally {
      setSubmitting(false);
    }
  };

    // !m-0: this overlay is often rendered inside a "space-y-*" list, whose
    // top margin would otherwise shift even a fixed element down the screen.
  return (
    <div className="fixed inset-0 !m-0 bg-black/80 z-50 flex items-start sm:items-center justify-center p-0 sm:p-4 overflow-y-auto" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Launch a gaming machine"
        className="bg-cyber-dark border border-neon-cyan/30 rounded-none sm:rounded-lg w-full max-w-2xl min-h-[100dvh] sm:min-h-0 sm:my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-3 sm:px-5 py-3 sm:py-4 sticky top-0 bg-cyber-dark z-10">
          <h2 className="text-sm tracking-label font-bold font-mono neon-text">[ LAUNCH_MACHINE ]</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm font-mono">[ CLOSE ]</button>
        </div>

        <div className="p-3 sm:p-5 space-y-4 sm:space-y-5">
          {loadError && <FriendlyErrorCard message={loadError.message} tip={loadError.tip} friendly={loadError.friendly} />}
          {!options && !loadError && <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; LOADING_OPTIONS…</p>}

          {operationId ? (
            <>
              <p className="text-sm text-slate-300">
                Launching now. You can close this window — the launch carries on, and its progress stays in the Activity panel.
              </p>
              <OperationConsole operationId={operationId} onFinished={() => onLaunched()} height="max-h-96" />
            </>
          ) : options && (
            <>
              {/* Cloud */}
              <div>
                <p className="label mb-2">1 · Cloud</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {options.providers.map((p) => (
                    <button
                      key={p.provider}
                      type="button"
                      onClick={() => setProvider(p.provider)}
                      className={`rounded border px-3 py-2 text-left text-xs transition ${
                        provider === p.provider ? 'border-neon-cyan text-slate-100 bg-neon-cyan/[0.06]' : 'border-white/10 text-slate-400 hover:border-white/30'
                      }`}
                    >
                      <span className="block font-semibold">{p.label}</span>
                      <span className={`block mt-0.5 ${!p.available ? 'text-slate-600' : p.configured ? (p.lastCheckOk === false ? 'text-neon-amber' : 'text-neon-lime') : 'text-slate-500'}`}>
                        {!p.available ? 'coming soon' : p.configured ? (p.lastCheckOk === false ? '⚠ check keys' : '✓ ready') : 'no keys yet'}
                      </span>
                    </button>
                  ))}
                </div>
                {blocker && (
                  <p className="mt-2 text-xs text-neon-amber">
                    ⚠ {blocker}{' '}
                    {current?.available && !current.configured && <Link href="/settings" className="underline text-neon-cyan">Open Config →</Link>}
                  </p>
                )}
                {current?.configured && current.lastCheckOk === false && (
                  <p className="mt-2 text-xs text-neon-amber">⚠ The last check of your keys found problems ({current.lastCheckSummary}). Launching may fail — see Config.</p>
                )}
              </div>

              {current && current.available && (
                <>
                  {/* Region */}
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="launch-region" className="label block mb-2">2 · Region</label>
                      <select id="launch-region" value={region} onChange={(e) => setRegion(e.target.value)} className="input-neon w-full px-3 py-2">
                        {current.regions.map((r) => (
                          <option key={r.id} value={r.id}>{access[`${provider}:${r.id}`] ? `${ACCESS_STYLE[access[`${provider}:${r.id}`].status].icon} ` : ''}{r.name} ({r.id}) · {r.gpus.join('/')}</option>
                        ))}
                      </select>
                      {(() => {
                        const a = access[`${provider}:${region}`];
                        const st = a ? statusFor(a, shape?.gpuModel) : null;
                        if (a && st === 'ready' && !spot && a.onDemandReady === false) {
                          return <p className="text-xs text-neon-amber mt-1">! Spot only here: your quota covers spot machines but not on-demand ({a.summary}). Tick spot below, or raise the on-demand quota. <Link href="/regions" className="text-neon-cyan hover:underline whitespace-nowrap">How to fix</Link></p>;
                        }
                        if (!a || st === 'ready' && !(spot && a.spotReady === false)) return <p className="text-xs text-slate-500 mt-1">{a ? <span className="text-neon-lime">✓ Your account has GPU quota here. </span> : null}Pick the one closest to you — distance adds lag.</p>;
                        const msg = st === 'ready' ? 'Your spot quota here is too low — launch on-demand, or raise it.'
                          : a.status === 'ready' ? `No ${shape?.gpuModel} quota here (${a.summary}). Pick a ${a.quotas.filter((q) => q.limit - q.used >= 1 && /T4|L4/.test(q.label)).map((q) => q.label.replace(/NVIDIA | GPUs/g, '')).join('/') || 'different'} size, or request it.`
                          : `${ACCESS_STYLE[a.status].label}: ${a.summary}. The launch will probably fail.`;
                        return <p className="text-xs text-neon-amber mt-1">! {msg} <Link href="/regions" className="text-neon-cyan hover:underline whitespace-nowrap">How to fix</Link></p>;
                      })()}
                    </div>
                    <div>
                      <label htmlFor="launch-disk" className="label block mb-2">4 · Disk size (GB)</label>
                      <input
                        id="launch-disk" type="number" min={current.minDiskGb} max={2000} step={10}
                        value={diskGb} onChange={(e) => setDiskGb(Number(e.target.value))}
                        className="input-neon w-full px-3 py-2"
                      />
                      <p className="text-xs text-slate-500 mt-1">≈ USD {diskMonthly.toFixed(2)}/month, charged even while stopped.</p>
                    </div>
                  </div>

                  {/* Size */}
                  <div>
                    <p className="label mb-2">3 · Machine size</p>
                    {shapesHere.length === 0 && <p className="text-xs text-neon-amber">No sizes available in this region — try another.</p>}
                    <div className="grid sm:grid-cols-2 gap-2">
                      {shapesHere.map((s) => {
                        const p = s.prices[region];
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setShapeId(s.id)}
                            className={`rounded border px-3 py-2 text-left text-xs transition ${
                              shapeId === s.id ? 'border-neon-cyan bg-neon-cyan/[0.06]' : 'border-white/10 hover:border-white/30'
                            }`}
                          >
                            <span className="flex justify-between gap-2">
                              <span className="font-semibold text-slate-100">{s.label}</span>
                              <span className="text-neon-lime tabular-nums">≈USD {p?.onDemand.toFixed(2)}/h</span>
                            </span>
                            {p?.spot != null && (
                              <span className="block mt-0.5 text-[0.68rem] text-slate-500 tabular-nums">
                                spot ≈USD {p.spot.toFixed(2)}/h
                                {p.spotDiscountPct != null && <> · −{p.spotDiscountPct}%{p.spotSource === 'estimate' ? ' est.' : ''}{p.spotSource === 'live' && p.spotDiscountPct >= 65 ? ' 🔥' : ''}</>}
                              </span>
                            )}
                            <span className="block text-slate-400 mt-1 leading-snug">{s.bestFor}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Spot */}
                  {current.supportsSpot && price?.spot != null && (
                    <label className="flex items-start gap-3 text-sm text-slate-300 rounded border border-white/10 p-3 cursor-pointer">
                      <input type="checkbox" className="mt-1" checked={spot} onChange={(e) => setSpot(e.target.checked)} />
                      <span>
                        Use a <strong>{current.spotLabel}</strong> — about USD {price.spot.toFixed(2)}/h instead of USD {price.onDemand.toFixed(2)}/h
                        {price.spotDiscountPct != null && (
                          <span className={`ml-1.5 inline-block whitespace-nowrap rounded border px-1 text-[0.66rem] uppercase tracking-label align-middle ${
                            price.spotSource === 'live' && price.spotDiscountPct >= 65 ? 'border-neon-lime/60 bg-neon-lime/10 text-neon-lime'
                            : price.spotSource === 'live' && price.spotDiscountPct >= 55 ? 'border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan' : 'border-white/15 text-slate-300'}`}>
                            {price.spotSource === 'live' && price.spotDiscountPct >= 65 ? '🔥 ' : ''}−{price.spotDiscountPct}%
                            {price.spotSource === 'live' ? ' live' : price.spotSource === 'estimate' ? ' est.' : ''}
                          </span>
                        )}
                        <span className="block text-xs text-slate-500 mt-0.5">
                          Not guaranteed: the cloud can take it back at short notice. {current.spotOnReclaim || 'Your game stops.'}
                          {price.spotInterruption && <> Here it’s reclaimed <span className={price.spotInterruption.level >= 3 ? 'text-neon-amber' : 'text-slate-300'}>{price.spotInterruption.label}</span> of the time.</>}
                          {' '}Great for casual play, risky for long sessions.
                        </span>
                      </span>
                    </label>
                  )}

                  {/* Big screen (experimental) */}
                  {current.bigScreen && (
                    <label className={`flex items-start gap-3 text-sm rounded border p-3 ${bigOk ? 'text-slate-300 border-neon-magenta/30 cursor-pointer' : 'text-slate-500 border-white/5'}`}>
                      <input type="checkbox" className="mt-1" disabled={!bigOk} checked={bigScreen && bigOk} onChange={(e) => setBigScreen(e.target.checked)} />
                      <span>
                        <span className="mr-1.5 inline-block rounded border border-neon-magenta/50 text-neon-magenta px-1 text-[0.62rem] uppercase tracking-label align-middle">Experimental</span>
                        <strong>Big screen</strong> — screens up to 4096×2160 (e.g. a 3440×1440 ultrawide at full size) instead of 2560×1600
                        {bigOk && current.bigScreen.extraPerHour > 0 && <> · <span className="text-neon-amber">+≈USD {current.bigScreen.extraPerHour.toFixed(2)}/h</span></>}
                        <span className="block text-xs text-slate-500 mt-0.5">
                          Installs NVIDIA&apos;s GRID (virtual workstation) driver instead of the standard one. {current.bigScreen.note}
                          {bigOk && ' Not tested end to end yet — if setup fails, launch again without it. Bigger screens need more GPU power and data.'}
                        </span>
                      </span>
                    </label>
                  )}

                  {/* Game + quality */}
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="launch-game" className="label block mb-2">5 · Main game (optional)</label>
                      <select id="launch-game" value={game} onChange={(e) => setGame(e.target.value)} className="input-neon w-full px-3 py-2">
                        <option value="">— none —</option>
                        {options.games.map((g) => <option key={g.title} value={g.title}>{g.title}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="launch-quality" className="label block mb-2">6 · Streaming quality</label>
                      <select id="launch-quality" value={quality} onChange={(e) => setQuality(e.target.value)} className="input-neon w-full px-3 py-2">
                        {options.qualities.map((q) => <option key={q} value={q}>{q[0].toUpperCase() + q.slice(1)} — {QUALITY_HINT[q]}</option>)}
                      </select>
                      <p className="text-xs text-slate-500 mt-1">Streamed data is billed by the cloud (≈USD {regionInfo?.egressPerGb.toFixed(2)}/GB here).</p>
                    </div>
                  </div>

                  {/* Auto-stop */}
                  <div>
                    <label htmlFor="launch-autostop" className="label block mb-2">7 · Auto-stop when idle</label>
                    <select id="launch-autostop" value={autoStop} onChange={(e) => setAutoStop(Number(e.target.value))} className="input-neon w-full sm:w-1/2 px-3 py-2">
                      <option value={15}>After 15 minutes without streaming (recommended)</option>
                      <option value={30}>After 30 minutes</option>
                      <option value={60}>After 1 hour</option>
                      <option value={0}>Never — I&apos;ll stop it myself</option>
                    </select>
                    <p className="text-xs text-slate-500 mt-1">
                      The machine watches for Moonlight traffic and big downloads, and shuts itself down when there&apos;s none — so a forgotten
                      machine stops billing. (Idle time during the first setup doesn&apos;t count.)
                    </p>
                  </div>

                  {/* Auto-shelve */}
                  <div>
                    <label htmlFor="launch-autoshelve" className="label block mb-2">8 · Auto-shelve when unused</label>
                    <select id="launch-autoshelve" value={autoShelve} onChange={(e) => setAutoShelve(Number(e.target.value))} className="input-neon w-full sm:w-1/2 px-3 py-2">
                      <option value={1}>After 1 day stopped</option>
                      <option value={3}>After 3 days stopped</option>
                      <option value={7}>After 7 days stopped (recommended)</option>
                      <option value={14}>After 14 days stopped</option>
                      <option value={30}>After 30 days stopped</option>
                      <option value={0}>Never — keep the disk</option>
                    </select>
                    <p className="text-xs text-slate-500 mt-1">
                      A stopped machine still pays for its whole disk (≈USD {diskMonthly.toFixed(2)}/month here). Shelving snapshots the disk and deletes it,
                      cutting that to ≈USD {shelfLow.toFixed(2)}–{shelfHigh.toFixed(2)}/month; Restore brings it back with your games (a few minutes longer than Start).
                      The disk is only deleted once the snapshot is confirmed complete. You can change this on the machine at any time.
                    </p>
                  </div>

                  {/* Summary + launch */}
                  <div className="rounded border border-neon-cyan/20 bg-neon-cyan/[0.03] p-4 text-sm">
                    <p className="text-slate-200">
                      <span className="text-neon-lime font-semibold tabular-nums">≈ USD {hourly.toFixed(2)}/hour</span> while running
                      {' '}+ <span className="tabular-nums">USD {diskMonthly.toFixed(2)}/month</span> for the disk (also while stopped).
                    </p>
                    <p className="text-xs text-slate-400 mt-1">Shelved when you&apos;re not using it: ≈USD {shelfLow.toFixed(2)}–{shelfHigh.toFixed(2)}/month.</p>
                    <p className="text-xs text-slate-500 mt-1">{current.priceNote} Billed by {current.label} to your account — stop the machine when you're done playing.</p>
                  </div>

                  {submitError && <FriendlyErrorCard friendly={submitError.friendly} message={submitError.message} tip={submitError.tip} />}

                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200 px-3">Cancel</button>
                    <button
                      type="button"
                      onClick={launch}
                      disabled={!!blocker || !shape || submitting}
                      className="btn-neon-magenta disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {submitting ? 'Starting…' : '[ LAUNCH ]'}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
