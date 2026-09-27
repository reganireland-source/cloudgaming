'use client';

/**
 * ============================================================================
 * frontend/components/MachineConnectionPanel.tsx — "HOW DO I PLAY ON IT?"
 * ============================================================================
 *
 * For one machine, shows (from GET /api/machines/:id/connection):
 *   - SETUP PROGRESS: the machine installs its own software after launch
 *     (driver → reboot → desktop → Sunshine → Steam). The backend reads the
 *     progress lines the setup script prints to the machine's serial
 *     console; we show them as a progress bar + stage list. Polls every 15 s
 *     until ready.
 *   - CONNECTION: the public IP, the Sunshine admin page link and its login
 *     (hidden until you click "Show"), with copy buttons.
 *   - PAIRING STEPS for Moonlight, the app you play on.
 *
 * The Sunshine login is generated per machine and stored encrypted; only
 * the machine's owner can fetch it.
 * ============================================================================
 */

import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/auth';

export interface ConnectionInfo {
  machineId: string;
  status: string;
  ipAddress: string | null;
  sunshineUrl: string | null;
  username?: string;
  password?: string;
  setup: {
    stages: Array<{ percent: number; key: string; message: string }>;
    current: { percent: number; key: string; message: string } | null;
    ready: boolean;
    failed: boolean;
    error?: string;
  };
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard blocked: the text is selectable anyway */ }
      }}
      className="text-[0.66rem] uppercase tracking-label text-neon-cyan/70 hover:text-neon-cyan"
    >
      {copied ? 'copied ✓' : 'copy'}
    </button>
  );
}

export default function MachineConnectionPanel({
  machineId, status, onStage,
}: {
  machineId: string;
  status: string;
  /** Tells the parent the latest setup stage (for the architecture diagram). */
  onStage?: (stage: ConnectionInfo['setup']['current']) => void;
}) {
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const data = await apiFetch<ConnectionInfo>(`/machines/${machineId}/connection`);
        if (cancelled) return;
        setInfo(data);
        setError(null);
        onStage?.(data.setup.current);
        // Keep polling while it's running but not finished setting up.
        if (data.status === 'running' && !data.setup.ready && !data.setup.failed) timer = setTimeout(load, 15000);
      } catch (e) {
        if (!cancelled) setError(e as ApiError);
      }
    };
    load();
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, status]);

  if (error) return <p className="text-xs text-neon-amber">⚠ {error.message}{error.tip ? ` — ${error.tip}` : ''}</p>;
  if (!info) return <p className="text-xs text-slate-500 animate-pulse">&gt; reading connection details…</p>;

  const pct = info.setup.current?.percent ?? 0;

  return (
    <div className="space-y-4 text-sm">
      {/* ---- Setup progress ---- */}
      {info.status === 'running' && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="label">On-machine setup</span>
            <span className={`text-xs tabular-nums ${info.setup.failed ? 'text-neon-pink' : info.setup.ready ? 'text-neon-lime' : 'text-neon-amber'}`}>
              {info.setup.failed ? 'failed' : info.setup.ready ? 'ready ✓' : `${pct}%`}
            </span>
          </div>
          <div className="h-1.5 rounded bg-white/5 overflow-hidden">
            <div
              className={`h-full transition-all ${info.setup.failed ? 'bg-neon-pink' : info.setup.ready ? 'bg-neon-lime' : 'bg-neon-amber'}`}
              style={{ width: `${info.setup.failed ? 100 : Math.max(pct, 3)}%` }}
            />
          </div>
          <p className="text-xs text-slate-400 mt-1.5">
            {info.setup.current
              ? info.setup.current.message
              : info.setup.error
              ? `Can't read progress yet: ${info.setup.error}`
              : 'Waiting for the machine to report progress (usually starts within 1–2 minutes of launch)…'}
          </p>
          {info.setup.failed && (
            <p className="text-xs text-slate-400 mt-1">
              The setup stopped at the step above. The full log is on the machine at /var/log/cloudgaming-setup.log (open the machine
              in your cloud console and use its SSH / serial console button). Deleting and relaunching retries from scratch.
            </p>
          )}
          {info.setup.stages.length > 1 && (
            <details className="mt-2">
              <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-300">All stages ({info.setup.stages.length})</summary>
              <ul className="mt-1 space-y-0.5 font-mono text-[0.7rem] text-slate-400">
                {info.setup.stages.map((s, i) => (
                  <li key={i}><span className="text-slate-600 tabular-nums">{String(s.percent).padStart(3, ' ')}%</span> {s.message}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* ---- Connection details ---- */}
      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-xs">
        <dt className="text-slate-500">IP address</dt>
        <dd className="flex items-center gap-3">
          <span className="font-mono text-slate-100">{info.ipAddress || '—'}</span>
          {info.ipAddress && <CopyButton value={info.ipAddress} />}
        </dd>
        <dt className="text-slate-500">Sunshine admin</dt>
        <dd className="flex items-center gap-3">
          {info.sunshineUrl ? (
            <a href={info.sunshineUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-neon-cyan hover:underline break-all">
              {info.sunshineUrl}
            </a>
          ) : '—'}
        </dd>
        <dt className="text-slate-500">Username</dt>
        <dd className="flex items-center gap-3">
          <span className="font-mono text-slate-100">{info.username || '—'}</span>
          {info.username && <CopyButton value={info.username} />}
        </dd>
        <dt className="text-slate-500">Password</dt>
        <dd className="flex items-center gap-3">
          <span className="font-mono text-slate-100">{info.password ? (showPassword ? info.password : '••••••••••••') : '—'}</span>
          {info.password && (
            <>
              <button type="button" onClick={() => setShowPassword((v) => !v)} className="text-[0.66rem] uppercase tracking-label text-neon-cyan/70 hover:text-neon-cyan">
                {showPassword ? 'hide' : 'show'}
              </button>
              <CopyButton value={info.password} />
            </>
          )}
        </dd>
      </dl>

      {/* ---- How to pair ---- */}
      <details open={info.setup.ready}>
        <summary className="label cursor-pointer">How to start playing</summary>
        <ol className="mt-2 list-decimal pl-5 space-y-1.5 text-xs text-slate-300 leading-relaxed">
          <li>Install <a href="https://moonlight-stream.org" target="_blank" rel="noopener noreferrer" className="text-neon-cyan hover:underline">Moonlight</a> on the device you'll play on (PC, Mac, phone, TV).</li>
          <li>In Moonlight, click <strong>+</strong> (Add PC) and enter the IP address above. Moonlight shows a 4-digit PIN.</li>
          <li>
            Open the Sunshine admin link above. Your browser will warn that the certificate is self-signed — that's expected for this
            machine; continue. Sign in with the username and password above.
          </li>
          <li>Go to <strong>PIN</strong>, type Moonlight's PIN, and submit. Moonlight is now paired (only needed once per device).</li>
          <li>In Moonlight, open the machine and pick <strong>Desktop</strong> or <strong>Steam Big Picture</strong>. Sign in to Steam and install your games.</li>
          <li>When you're done, <strong>stop</strong> the machine here so it stops billing. Your games stay on its disk.</li>
        </ol>
        <p className="mt-2 text-[0.7rem] text-slate-500">
          Note: after a stop/start the IP may change — if Moonlight can't find the machine, add the new IP. Games with kernel anti-cheat
          (e.g. Valorant, Fortnite) don&apos;t run on these Linux machines; most Steam games do, via Proton.
        </p>
      </details>
    </div>
  );
}
