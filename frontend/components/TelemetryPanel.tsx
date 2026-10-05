'use client';

/**
 * components/TelemetryPanel.tsx — LIVE MACHINE TELEMETRY
 *
 * Reads GET /api/machines/:id/telemetry: the samples the machine's agent
 * prints to its serial console every 15 s (the backend reads the console
 * through the cloud's API — no ports opened), stored for 7 days. While the
 * panel is on screen it refreshes every 15 s (paused while the tab is hidden).
 *
 * Layout: alerts (icon + words) → key stat tiles, each with a one-series
 * trend line (hover for value and time) → details (clocks, containers,
 * failed services, busiest processes, errors). `compact` = tiles only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/auth';

type G = Record<string, number | string | null>;
interface Sample {
  t: number; c?: number | null; cm?: number | null; l?: number | null; m?: [number, number]; sw?: number | null;
  d?: [number, number]; dr?: number | null; dw?: number | null; ni?: number | null; no?: number | null;
  g?: G | null; gf?: { n: string; f: number | null; lo: number | null; ft: number | null } | null; sn?: { e: string[]; x: number } | null; ct?: number | null; up?: number | null; x?: number; xl?: string | null; o?: number; f?: string[]; k?: string[]; p?: Array<[string, string]>;
}
interface Alert { level: 'critical' | 'warning' | 'info'; key: string; text: string }
interface Telemetry { samples: Sample[]; latest: Sample | null; alerts: Alert[]; readAt: string | null; note?: string }

const RANGES = [{ m: 15, label: '15 min' }, { m: 60, label: '1 h' }, { m: 360, label: '6 h' }, { m: 1440, label: '24 h' }];
const ALERT = {
  critical: { icon: '✖', cls: 'border-neon-pink/50 text-neon-pink bg-neon-pink/[0.06]', word: 'Critical' },
  warning: { icon: '▲', cls: 'border-neon-amber/50 text-neon-amber bg-neon-amber/[0.05]', word: 'Warning' },
  info: { icon: 'ℹ', cls: 'border-neon-cyan/40 text-neon-cyan bg-neon-cyan/[0.04]', word: 'Note' },
};
/** NVIDIA's clock-limit bit mask in words (0x1 idle and 0x4 app clocks aren't problems). */
function throttleWords(hex: string): string {
  const m = /^0x[0-9a-f]+$/i.test(hex) ? parseInt(hex, 16) : 0;
  const why = [[0x2, 'power cap'], [0x8, 'hardware slowdown'], [0x20, 'software heat limit'], [0x40, 'hardware heat limit'], [0x80, 'power brake'], [0x100, 'display clocks']]
    .filter(([b]) => m & (b as number)).map(([, w]) => w);
  return why.length ? `▲ GPU clocks held back: ${why.join(', ')}` : '✓ GPU clocks not held back';
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmt = (v: number | null, d = 0) => (v == null ? '—' : v.toFixed(d));
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
function upFor(s?: number | null) {
  if (s == null) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h >= 48 ? `${Math.floor(h / 24)} days` : h ? `${h} h ${m} min` : `${m} min`;
}

/** One-series trend line with a hover crosshair + value. */
function Spark({ samples, pick, unit, max, warnAt, digits = 0 }: {
  samples: Sample[]; pick: (s: Sample) => number | null; unit: string; max?: number; warnAt?: number; digits?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const pts = samples.map((s) => ({ t: s.t, v: pick(s) })).filter((p): p is { t: number; v: number } => p.v != null);
  if (pts.length < 2) return <div className="h-9 text-[0.62rem] text-slate-600 flex items-end">collecting…</div>;
  const W = 200, H = 36, t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const top = Math.max(max ?? 0, ...pts.map((p) => p.v), warnAt ?? 0) || 1;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => H - 2 - (v / top) * (H - 4);
  // Gaps over 2 minutes (machine stopped) break the line.
  let d = '';
  pts.forEach((p, i) => { d += `${i && p.t - pts[i - 1].t <= 120 ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`; });
  const h = hover != null ? pts[hover] : null;
  return (
    <div className="relative">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-9 overflow-visible"
        onMouseMove={(e) => {
          const r = ref.current!.getBoundingClientRect(); const tx = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
          let best = 0; pts.forEach((p, i) => { if (Math.abs(p.t - tx) < Math.abs(pts[best].t - tx)) best = i; }); setHover(best);
        }} onMouseLeave={() => setHover(null)} role="img" aria-label={`Trend, latest ${pts[pts.length - 1].v.toFixed(digits)}${unit}`}>
        {warnAt != null && <line x1={0} x2={W} y1={y(warnAt)} y2={y(warnAt)} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" className="text-neon-amber" />}
        <path d={d} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" className="text-neon-cyan" />
        {h && <>
          <line x1={x(h.t)} x2={x(h.t)} y1={0} y2={H} stroke="currentColor" strokeOpacity={0.4} vectorEffect="non-scaling-stroke" className="text-slate-300" />
          <circle cx={x(h.t)} cy={y(h.v)} r={2.5} fill="currentColor" className="text-neon-cyan" stroke="#0c1018" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </>}
      </svg>
      {h && (
        <span className="pointer-events-none absolute -top-5 rounded bg-cyber-darker border border-white/15 px-1 text-[0.62rem] text-slate-200 tabular-nums whitespace-nowrap"
          style={{ left: `${Math.min(70, Math.max(0, (x(h.t) / W) * 100 - 10))}%` }}>
          {h.v.toFixed(digits)}{unit} · {clock(h.t)}
        </span>
      )}
    </div>
  );
}

function Tile({ label, value, sub, tone, children }: { label: string; value: string; sub?: string; tone?: 'warn' | 'bad'; children?: React.ReactNode }) {
  return (
    <div className="rounded border border-white/10 bg-white/[0.02] px-2.5 pt-2 pb-1.5 min-w-0">
      <p className="text-[0.64rem] uppercase tracking-label text-slate-500">{label}</p>
      <p className={`text-base tabular-nums leading-tight ${tone === 'bad' ? 'text-neon-pink' : tone === 'warn' ? 'text-neon-amber' : 'text-slate-100'}`}>
        {value}{tone && <span className="sr-only"> ({tone === 'bad' ? 'critical' : 'warning'})</span>}
      </p>
      <p className="text-[0.66rem] text-slate-500 tabular-nums truncate">{sub || ' '}</p>
      {children}
    </div>
  );
}

export default function TelemetryPanel({ machineId, status, compact = false }: { machineId: string; status: string; compact?: boolean }) {
  const [range, setRange] = useState(compact ? 60 : 15);
  const [data, setData] = useState<Telemetry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await apiFetch<Telemetry>(`/machines/${machineId}/telemetry?minutes=${range}`)); setError(null); }
    catch (e: any) { setError(e?.message || 'Couldn’t read telemetry.'); }
  }, [machineId, range]);
  useEffect(() => {
    load();
    if (status !== 'running') return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15_000);
    return () => clearInterval(timer);
  }, [load, status]);

  const s = data?.latest || null;
  const g = s?.g || null;
  const samples = data?.samples || [];
  const ageS = s ? Math.max(0, Math.round(Date.now() / 1000 - s.t)) : null;
  const stale = ageS != null && ageS > 120;
  const tiles = useMemo(() => {
    if (!s) return null;
    const tp = num(g?.tp), vu = num(g?.vu), vt = num(g?.vt), pw = num(g?.pw), pl = num(g?.pl), es = num(g?.es);
    const ram = s.m?.[1] ? s.m[0] / s.m[1] : 0, disk = s.d?.[1] ? s.d[0] / s.d[1] : 0;
    return (
      <div className={`grid gap-2 ${compact ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 md:grid-cols-4'}`}>
        <Tile label="GPU load" value={g ? `${fmt(num(g.u))}%` : 'no GPU data'} sub={g ? `peak ${fmt(num(g.um))}% · ${g.ps || ''}${num(g.eu) != null ? ` · encoder ${fmt(num(g.eu))}%` : ''}` : 'driver not loaded yet?'}>
          <Spark samples={samples} pick={(x) => num(x.g?.u)} unit="%" max={100} />
        </Tile>
        <Tile label="GPU temp" value={tp != null ? `${tp} °C` : '—'} tone={tp != null && tp >= 87 ? 'bad' : tp != null && tp >= 80 ? 'warn' : undefined}
          sub={pw != null ? `${fmt(pw)} of ${fmt(pl)} W` : ''}>
          <Spark samples={samples} pick={(x) => num(x.g?.tp)} unit=" °C" warnAt={80} />
        </Tile>
        <Tile label="Video memory" value={vu != null && vt ? `${(vu / 1024).toFixed(1)} / ${(vt / 1024).toFixed(0)} GB` : '—'}
          tone={vu != null && vt && vu / vt >= 0.95 ? 'warn' : undefined} sub={num(g?.cl) != null ? `${fmt(num(g?.cl))} of ${fmt(num(g?.cx))} MHz` : ''}>
          <Spark samples={samples} pick={(x) => { const a = num(x.g?.vu); return a == null ? null : a / 1024; }} unit=" GB" max={vt ? vt / 1024 : undefined} digits={1} />
        </Tile>
        {s.gf ? (
          <Tile label={`Game fps · ${s.gf.n}`} value={`${fmt(s.gf.f)} fps`} tone={s.gf.f != null && s.gf.f < 30 ? 'warn' : undefined}
            sub={`low ${fmt(s.gf.lo)} · worst frame ${fmt(s.gf.ft, 0)} ms${es ? ` · stream ${fmt(num(g?.ef))} fps` : ''}`}>
            <Spark samples={samples} pick={(x) => x.gf?.f ?? null} unit=" fps" />
          </Tile>
        ) : (
          <Tile label="Stream encoder" value={es ? `${fmt(num(g?.ef))} fps` : 'not streaming'}
            sub={es ? `${es} session${es === 1 ? '' : 's'} · ${fmt((num(g?.el) ?? 0) / 1000, 1)} ms encode · no game fps yet` : 'starts when Moonlight connects'}>
            <Spark samples={samples} pick={(x) => (num(x.g?.es) ? num(x.g?.ef) : 0)} unit=" fps" />
          </Tile>
        )}
        <Tile label="CPU" value={`${fmt(s.c ?? null)}%`} tone={(s.cm ?? 0) >= 97 ? 'warn' : undefined} sub={`peak ${fmt(s.cm ?? null)}% · load ${fmt(s.l ?? null, 1)}${s.ct != null ? ` · ${s.ct} °C` : ''}`}>
          <Spark samples={samples} pick={(x) => x.c ?? null} unit="%" max={100} />
        </Tile>
        <Tile label="RAM" value={s.m ? `${s.m[0]} / ${s.m[1]} GB` : '—'} tone={ram >= 0.92 ? 'warn' : undefined} sub={s.sw ? `swap ${s.sw} GB` : `${Math.round(ram * 100)}% used`}>
          <Spark samples={samples} pick={(x) => x.m?.[0] ?? null} unit=" GB" max={s.m?.[1]} digits={1} />
        </Tile>
        <Tile label="Network out" value={`${fmt(s.no ?? null, 1)} Mbit/s`} sub={`in ${fmt(s.ni ?? null, 1)} Mbit/s`}>
          <Spark samples={samples} pick={(x) => x.no ?? null} unit=" Mbit/s" digits={1} />
        </Tile>
        <Tile label="Disk" value={s.d ? `${s.d[0].toFixed(0)} / ${s.d[1].toFixed(0)} GB` : '—'} tone={disk >= 0.9 ? 'warn' : undefined}
          sub={`read ${fmt(s.dr ?? null, 1)} · write ${fmt(s.dw ?? null, 1)} MB/s`}>
          <Spark samples={samples} pick={(x) => (x.dr ?? 0) + (x.dw ?? 0)} unit=" MB/s" digits={1} />
        </Tile>
      </div>
    );
  }, [s, g, samples, compact]);

  if (!data && !error) return <p className="text-xs text-slate-500 animate-pulse">Reading telemetry…</p>;
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.7rem] text-slate-500">
        {status === 'running' && <span className="inline-flex items-center gap-1"><span className={`inline-block w-1.5 h-1.5 rounded-full ${stale ? 'bg-neon-amber' : 'bg-neon-lime animate-pulse'}`} />{stale ? 'no new reading' : 'live'}</span>}
        {s && <span className="tabular-nums">reading from {ageS! < 90 ? `${ageS} s` : `${Math.round(ageS! / 60)} min`} ago · machine up {upFor(s.up)}</span>}
        <div role="radiogroup" aria-label="Time range" className="inline-flex rounded border border-white/10 overflow-hidden ml-auto">
          {RANGES.map((r) => (
            <button key={r.m} type="button" role="radio" aria-checked={range === r.m} onClick={() => setRange(r.m)}
              className={`px-2 py-0.5 border-l first:border-l-0 border-white/10 ${range === r.m ? 'bg-neon-cyan/10 text-neon-cyan' : 'hover:text-slate-300'}`}>{r.label}</button>
          ))}
        </div>
      </div>
      {error && <p className="text-xs text-neon-amber">⚠ {error}</p>}
      {data?.note && <p className="text-[0.72rem] text-slate-400">{data.note}</p>}
      {!!data?.alerts.length && (
        <ul className="space-y-1">
          {data.alerts.map((a) => (
            <li key={a.key} className={`rounded border px-2 py-1 text-xs ${ALERT[a.level].cls}`}>
              <span aria-hidden className="mr-1.5">{ALERT[a.level].icon}</span><span className="sr-only">{ALERT[a.level].word}: </span>{a.text}
            </li>
          ))}
        </ul>
      )}
      {tiles}
      {!compact && s && (
        <div className="grid gap-2 md:grid-cols-3 text-[0.72rem] text-slate-400">
          <div className="rounded border border-white/10 px-2.5 py-2 space-y-0.5">
            <p className="label mb-1">Busiest programs</p>
            {(s.p || []).map(([name, pct], i) => <p key={i} className="flex justify-between gap-2 tabular-nums"><span className="truncate text-slate-300">{name}</span><span>{pct}%</span></p>)}
            {!s.p?.length && <p>—</p>}
          </div>
          <div className="rounded border border-white/10 px-2.5 py-2 space-y-0.5">
            <p className="label mb-1">Containers</p>
            {(s.k || []).map((k) => <p key={k} className={/:\s*Up\b/.test(k) ? 'text-slate-300' : 'text-neon-amber'}>{/:\s*Up\b/.test(k) ? '✓ ' : '▲ '}{k}</p>)}
            {!s.k?.length && <p>none yet (setup still installing?)</p>}
            {!!s.f?.length && <p className="text-neon-amber">▲ failed services: {s.f.join(', ')}</p>}
            {(s.sn?.x ?? 0) > 1 && <p className="text-neon-amber">▲ Sunshine restarted {s.sn!.x} times recently</p>}
            {s.sn?.e?.map((e, i) => <p key={i} className="text-slate-500 break-words">Sunshine: {e}</p>)}
          </div>
          <div className="rounded border border-white/10 px-2.5 py-2 space-y-0.5">
            <p className="label mb-1">Errors since boot</p>
            <p>{s.x ? <span className="text-neon-pink">✖ {s.x} GPU (Xid)</span> : '✓ no GPU errors'}</p>
            {s.xl && <p className="text-slate-500 break-words">{s.xl}</p>}
            <p>{s.o ? <span className="text-neon-pink">✖ {s.o} out-of-memory kill{s.o === 1 ? '' : 's'}</span> : '✓ no out-of-memory kills'}</p>
            {g?.th && <p>{throttleWords(String(g.th))}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** One line of key stats for lists (Dashboard): GPU, temperature, CPU, stream fps, alerts. */
export function TelemetryLine({ machineId }: { machineId: string }) {
  const [data, setData] = useState<Telemetry | null>(null);
  useEffect(() => {
    const load = () => apiFetch<Telemetry>(`/machines/${machineId}/telemetry?minutes=5`).then(setData).catch(() => undefined);
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30_000);
    return () => clearInterval(timer);
  }, [machineId]);
  const s = data?.latest;
  if (!s || Date.now() / 1000 - s.t > 300) return null;
  const g = s.g || {};
  const worst = data!.alerts.find((a) => a.level === 'critical') || data!.alerts.find((a) => a.level === 'warning');
  const parts = [
    num(g.u) != null ? `GPU ${fmt(num(g.u))}%` : null,
    num(g.tp) != null ? `${g.tp} °C` : null,
    `CPU ${fmt(s.c ?? null)}%`,
    s.m ? `RAM ${s.m[0]}/${s.m[1]} GB` : null,
    s.gf ? `${fmt(s.gf.f)} fps in ${s.gf.n}` : num(g.es) ? `${fmt(num(g.ef))} fps streaming` : null,
  ].filter(Boolean);
  return (
    <span className="block text-[0.68rem] text-slate-400 tabular-nums truncate" title={worst?.text}>
      {worst && <span className={worst.level === 'critical' ? 'text-neon-pink' : 'text-neon-amber'}>{ALERT[worst.level].icon} </span>}
      {parts.join(' · ')}
    </span>
  );
}
