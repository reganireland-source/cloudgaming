'use client';

/**
 * components/LocalDiagnose.tsx — "WHY IS IT LAGGY?" FOR A LOCAL PC (the Diagnose tab)
 *
 *   Run diagnostics   one snapshot: network link, power plan, GPU, Sunshine settings + log, Windows errors
 *   Record            samples once a second while you stream (GPU, encoder, clocks, CPU, network, ping
 *                     to the router), drawn live as they arrive, then saved and analysed
 *   Get logs          Sunshine's log and the agent's
 *   Tuning            a short list of reversible changes: power plan, GPU clocks, a few Sunshine settings
 * Findings are worked out by the backend (services/LocalDiagnostics.ts), so a button here only shows
 * what it says. "Copy report for Claude" puts the findings, numbers and log tail in one paste.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, type ApiError } from '@/lib/auth';

interface Finding { id: string; severity: 'bad' | 'warn' | 'info' | 'ok'; title: string; detail: string; fix?: { label: string; kind: string; args?: Record<string, unknown> } }
interface Stats { n: number; min: number; avg: number; p95: number; max: number }
interface Report { id: string; kind: string; createdAt: string; data: any; findings: Finding[]; series: Record<string, Stats>; text: string }
interface ReportRow { id: string; kind: string; createdAt: string }
interface Sample { seq: number; [k: string]: number | boolean }

const errText = (e: unknown) => `${(e as ApiError)?.message || 'That didn’t work.'}${(e as ApiError)?.tip ? ` ${(e as ApiError).tip}` : ''}`;
const timeAgo = (iso: string) => { const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(iso).toLocaleDateString(); };
const ICON: Record<Finding['severity'], { c: string; t: string }> = { bad: { c: 'text-neon-pink', t: '✗' }, warn: { c: 'text-neon-amber', t: '!' }, info: { c: 'text-neon-cyan', t: 'i' }, ok: { c: 'text-neon-lime', t: '✓' } };

const SETTINGS: Array<{ key: string; label: string; values: string[]; hint: string }> = [
  { key: 'min_log_level', label: 'Sunshine log detail', values: ['info', 'debug', 'verbose'], hint: 'debug writes more into the log: use it while chasing a problem' },
  { key: 'nvenc_preset', label: 'NVIDIA encoder preset', values: ['1', '2', '3', '4', '5', '6', '7'], hint: '1 = fastest, 7 = best quality (slower)' },
  { key: 'nvenc_latency_over_power', label: 'Favour low latency over power saving', values: ['enabled', 'disabled'], hint: '' },
  { key: 'nvenc_realtime_hags', label: 'Encoder priority under heavy GPU load', values: ['enabled', 'disabled'], hint: '' },
  { key: 'nvenc_twopass', label: 'NVIDIA two-pass', values: ['disabled', 'quarter_res', 'full_res'], hint: 'disabled is fastest' },
  { key: 'capture', label: 'Screen capture method', values: ['ddx', 'wgc'], hint: 'ddx (Desktop Duplication) or wgc (Windows Graphics Capture): try the other if capture stutters' },
  { key: 'encoder', label: 'Encoder', values: ['nvenc', 'software'], hint: 'software only to test: it is much slower than the GPU' },
];

function Spark({ label, values, max, unit, bad }: { label: string; values: number[]; max?: number; unit: string; bad?: (v: number) => boolean }) {
  const w = 150, h = 34;
  const top = max ?? Math.max(1, ...values);
  const pts = values.map((v, i) => `${values.length < 2 ? 0 : (i / (values.length - 1)) * w},${h - (Math.min(v, top) / top) * (h - 2) - 1}`).join(' ');
  const last = values.length ? values[values.length - 1] : null;
  const worst = bad && last != null && bad(last);
  return (
    <div className="min-w-[10rem]">
      <p className="label">{label}</p>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-9 bg-black/30 rounded" aria-hidden>
        {values.length > 1 && <polyline points={pts} fill="none" stroke={worst ? '#ec8aa8' : '#5fd7e0'} strokeWidth="1.5" />}
      </svg>
      <p className={`text-xs tabular-nums ${worst ? 'text-neon-pink' : 'text-slate-200'}`}>{last == null ? '—' : `${Math.round(last * 10) / 10} ${unit}`}</p>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="btn-neon text-xs" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1600); } catch { /* select by hand */ } }}>{done ? 'Copied ✓' : label}</button>;
}

export default function LocalDiagnose({ id, name, online }: { id: string; name: string; online: boolean }) {
  const stop = useRef(false);
  useEffect(() => { stop.current = false; return () => { stop.current = true; }; }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [seconds, setSeconds] = useState(60);
  const [live, setLive] = useState<Sample[]>([]);
  const [setting, setSetting] = useState(SETTINGS[0].key);
  const [value, setValue] = useState(SETTINGS[0].values[1]);

  const loadRows = useCallback(() => apiFetch<ReportRow[]>(`/local-machines/${id}/reports`).then((r) => { setRows(r); return r; }).catch(() => [] as ReportRow[]), [id]);
  const open = useCallback(async (rid: string) => {
    try { setReport(await apiFetch<Report>(`/local-machines/${id}/reports/${rid}`)); } catch (e) { setNote({ ok: false, text: errText(e) }); }
  }, [id]);
  useEffect(() => { loadRows().then((r) => { if (r[0]) open(r[0].id); }); }, [loadRows, open]);

  /** Sends a command and waits for the PC's answer; for recordings also draws the live samples. */
  const run = async (kind: string, args?: Record<string, unknown>, label?: string) => {
    setBusy(kind); setNote(null); setLive([]);
    try {
      const c = await apiFetch<{ id: string }>(`/local-machines/${id}/commands`, { method: 'POST', body: { kind, args } });
      let since = 0; let result: { status: string; result: string | null } | null = null;
      for (let i = 0; i < 400 && !stop.current; i++) {
        if (kind === 'record') {
          try { const l = await apiFetch<{ samples: Sample[]; seq: number }>(`/local-machines/${id}/live?since=${since}`); if (l.samples.length) { since = l.seq; setLive((p) => [...p, ...l.samples].slice(-400)); } } catch { /* keep going */ }
        }
        const s = await apiFetch<{ status: string; result: string | null }>(`/local-machines/${id}/commands/${c.id}`).catch(() => null);
        if (s && ['done', 'failed', 'expired'].includes(s.status)) { result = s; break; }
        await new Promise((r) => setTimeout(r, 1500));
      }
      setNote({ ok: result?.status === 'done', text: result ? (result.result || result.status) : `${label || kind}: no answer yet. Is the PC on?` });
      if (result?.status === 'done' && ['diagnose', 'record', 'logs'].includes(kind)) {
        const r = await loadRows();
        const mine = r.find((x) => x.kind === kind) || r[0];
        if (mine) await open(mine.id);
      }
    } catch (e) { setNote({ ok: false, text: errText(e) }); } finally { setBusy(null); }
  };

  const series = (k: string) => live.map((s) => s[k]).filter((v): v is number => typeof v === 'number');
  const d = report?.data;
  const btn = 'btn-neon text-xs disabled:opacity-40';
  const sel = SETTINGS.find((x) => x.key === setting)!;
  return (
    <div className="space-y-4 text-xs">
      <div className="space-y-2">
        <p className="text-slate-400">Why is it laggy? Measure the PC, then read what it found. Nothing here changes anything: the changes are further down, each one reversible.</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btn} disabled={!online || !!busy} onClick={() => run('diagnose', undefined, 'Diagnostics')}>{busy === 'diagnose' ? 'Collecting…' : 'Run diagnostics'}</button>
          <span className="text-slate-600">|</span>
          <label className="flex items-center gap-1.5 text-slate-300">Record while I play
            <select className="input-neon px-2 py-1 text-xs" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} disabled={!!busy}>
              {[30, 60, 120, 300].map((s) => <option key={s} value={s}>{s} seconds</option>)}
            </select></label>
          <button type="button" className={btn} disabled={!online || !!busy} onClick={() => run('record', { seconds }, 'Recording')}>{busy === 'record' ? 'Recording…' : 'Record'}</button>
          <span className="text-slate-600">|</span>
          <button type="button" className={btn} disabled={!online || !!busy} onClick={() => run('logs', { lines: 400 }, 'Logs')}>{busy === 'logs' ? 'Fetching…' : 'Get logs'}</button>
        </div>
        <p className="text-slate-500">Start a stream (or the game) first, then press Record: it samples the PC once a second and draws it live below. The numbers only mean something while streaming.</p>
        {!online && <p className="text-neon-amber">The PC isn’t connected, so nothing can be measured right now.</p>}
        {note && <p role="status" className={note.ok ? 'text-neon-lime' : 'text-neon-amber'}>{note.ok ? '✓ ' : '⚠ '}{note.text}</p>}
      </div>

      {busy === 'record' && (
        <div className="rounded border border-neon-cyan/30 p-3 space-y-2">
          <p className="text-slate-300">Live from {name}{live.length ? '' : ' (waiting for the first samples…)'}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Spark label="GPU" values={series('gpuUtil')} max={100} unit="%" />
            <Spark label="Encoder" values={series('encUtil')} max={100} unit="%" bad={(v) => v > 80} />
            <Spark label="GPU clock" values={series('smClock')} unit="MHz" />
            <Spark label="CPU" values={series('cpu')} max={100} unit="%" bad={(v) => v > 85} />
            <Spark label="Sent" values={series('txMbps')} unit="Mbit/s" />
            <Spark label="Router ping" values={series('pingMs')} unit="ms" bad={(v) => v > 5} />
          </div>
        </div>
      )}

      {report && (
        <div className="space-y-3 border-t border-white/5 pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <p className="label">{report.kind === 'record' ? 'Recording' : report.kind === 'logs' ? 'Logs' : 'Diagnostics'} · {timeAgo(report.createdAt)}</p>
            {rows.length > 1 && (
              <select className="input-neon px-2 py-1 text-xs" value={report.id} onChange={(e) => open(e.target.value)} aria-label="Earlier reports">
                {rows.map((r) => <option key={r.id} value={r.id}>{r.kind} · {timeAgo(r.createdAt)}</option>)}
              </select>
            )}
            <CopyButton text={report.text} label="Copy report for Claude" />
          </div>

          {report.findings.length > 0 && (
            <ul className="space-y-1.5">
              {report.findings.map((f) => (
                <li key={f.id} className="flex gap-2">
                  <span className={`w-4 text-center font-bold ${ICON[f.severity].c}`}>{ICON[f.severity].t}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-slate-100 break-words">{f.title}</p>
                    {f.detail && <p className="text-slate-500 break-words">{f.detail}</p>}
                    {f.fix && <button type="button" className="mt-1 btn-neon text-xs disabled:opacity-40" disabled={!online || !!busy} onClick={() => run(f.fix!.kind, f.fix!.args, f.fix!.label)}>{f.fix.label}</button>}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {report.kind === 'record' && Object.keys(report.series).length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-xs tabular-nums min-w-[28rem]">
                <thead><tr className="text-slate-500 text-left"><th className="pr-4 font-normal">Measured</th><th className="pr-4 font-normal">lowest</th><th className="pr-4 font-normal">average</th><th className="pr-4 font-normal">95% under</th><th className="font-normal">highest</th></tr></thead>
                <tbody>
                  {([['gpuUtil', 'GPU %'], ['encUtil', 'Encoder %'], ['smClock', 'GPU clock MHz'], ['powerW', 'GPU power W'], ['tempC', 'GPU °C'], ['cpu', 'CPU %'], ['txMbps', 'Sent Mbit/s'], ['pingMs', 'Router ping ms']] as const).filter(([k]) => report.series[k]?.n).map(([k, label]) => (
                    <tr key={k} className="text-slate-200"><td className="pr-4 text-slate-400">{label}</td><td className="pr-4">{report.series[k].min}</td><td className="pr-4">{report.series[k].avg}</td><td className="pr-4">{report.series[k].p95}</td><td>{report.series[k].max}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {report.kind === 'logs' && (
            <details open>
              <summary className="cursor-pointer text-slate-400">Sunshine log ({(d?.sunshine || []).length} lines)</summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all text-[0.7rem] font-mono text-slate-300 bg-black/40 border border-white/10 rounded p-2">{(d?.sunshine || []).join('\n') || '(empty: is Sunshine logging to its usual place?)'}</pre>
              <details className="mt-2"><summary className="cursor-pointer text-slate-400">Agent log</summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[0.7rem] font-mono text-slate-300 bg-black/40 border border-white/10 rounded p-2">{(d?.agent || []).join('\n')}</pre></details>
              <div className="mt-2"><CopyButton text={[...(d?.sunshine || []).slice(-150)].join('\n')} label="Copy the last 150 log lines" /></div>
            </details>
          )}
          {report.kind === 'diagnose' && d?.sunshine?.version && <p className="text-slate-500">Sunshine {String(d.sunshine.version).replace(/^.*?(\d+\.\d+[^\s]*).*$/, '$1')} · {d.os?.caption} · GPU driver {d.gpu?.driver}</p>}
        </div>
      )}

      <div className="space-y-3 border-t border-white/5 pt-3">
        <p className="label">Tuning (each one can be undone)</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn} disabled={!online || !!busy} onClick={() => run('power-plan', { plan: 'high' })}>Power plan: High performance</button>
          <button type="button" className={btn} disabled={!online || !!busy} onClick={() => run('power-plan', { plan: 'restore' })}>Put the power plan back</button>
          <button type="button" className={btn} disabled={!online || !!busy} onClick={() => run('gpu-clocks', { action: 'lock' })}>Lock GPU clocks</button>
          <button type="button" className={btn} disabled={!online || !!busy} onClick={() => run('gpu-clocks', { action: 'reset' })}>Unlock GPU clocks</button>
        </div>
        <p className="text-slate-500">Locking keeps the GPU at its full speed (it runs hotter and uses more power) until you unlock it or the PC restarts.</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1"><span className="label">Sunshine setting</span>
            <select className="input-neon px-2 py-1 text-xs block" value={setting} onChange={(e) => { setSetting(e.target.value); setValue(SETTINGS.find((x) => x.key === e.target.value)!.values[0]); }}>
              {SETTINGS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
          <label className="space-y-1"><span className="label">to</span>
            <select className="input-neon px-2 py-1 text-xs block" value={value} onChange={(e) => setValue(e.target.value)}>{sel.values.map((v) => <option key={v}>{v}</option>)}</select></label>
          <button type="button" className={btn} disabled={!online || !!busy} onClick={() => run('sunshine-config', { key: setting, value })}>Apply and restart Sunshine</button>
          <button type="button" className={btn} disabled={!online || !!busy} onClick={() => run('sunshine-config-restore')}>Restore the previous Sunshine config</button>
        </div>
        {sel.hint && <p className="text-slate-500">{sel.hint}. Sunshine restarts, which ends any stream in progress; its previous config file is kept.</p>}
      </div>
    </div>
  );
}
