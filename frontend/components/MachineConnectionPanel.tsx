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
import MoonlightLauncher from './MoonlightLauncher';

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
    /** Not read live just now: the last stages seen, at lastSeenAt. */
    stale?: boolean;
    lastSeenAt?: string | null;
    /** Setup unfinished and the machine stopped or went quiet: offer "Resume setup". */
    interrupted?: boolean;
    stuck?: boolean;
    /** Why it stopped, when the cloud says (e.g. spot machine reclaimed). */
    stopReason?: string | null;
  };
  /** Browser access (machines set up since it was added); `checked` = the ports were probed. */
  browser?: {
    checked: boolean;
    desktop: { url: string | null; available: boolean };
    play: { url: string | null; available: boolean };
  };
}

/**
 * The three ways into a machine, side by side, so it's obvious which to use:
 *   Moonlight app    best for games (install once)
 *   Use the desktop  KasmVNC in a browser tab: reliable, ~30 fps, clipboard
 *   Play in browser  Moonlight Web: GPU-quality stream in Chrome/Edge — experimental
 */
function WaysToConnect({ info }: { info: ConnectionInfo }) {
  const b = info.browser;
  const ready = info.setup.ready;
  const missing = (x?: { available: boolean }) => !!b?.checked && !x?.available;
  const Option = ({ title, badge, badgeCls, children, href, cta, available, note }: {
    title: string; badge: string; badgeCls: string; children: React.ReactNode; href?: string | null; cta?: string; available?: boolean; note?: string;
  }) => (
    <div className="rounded-md border border-white/10 bg-white/[0.02] p-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-semibold text-slate-100">{title}</span>
        <span className={`text-[0.64rem] uppercase tracking-label rounded border px-1.5 py-px ${badgeCls}`}>{badge}</span>
      </div>
      <p className="text-xs text-slate-400 leading-relaxed flex-1">{children}</p>
      {href !== undefined && (available && href
        ? <a href={href} target="_blank" rel="noopener noreferrer" className="btn-neon text-xs text-center">{cta} ↗</a>
        : <span className="text-[0.7rem] text-slate-500">{note}</span>)}
    </div>
  );
  const unavailable = !ready ? 'Available once setup is ready.' : 'Not on this machine: it was set up before browser access was added. Launch a new machine to get it.';
  return (
    <div className="space-y-2">
      <p className="label">Three ways to connect</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <Option title="Moonlight app" badge="Best for games" badgeCls="border-neon-lime/50 text-neon-lime">
          Full quality and the lowest lag, with controllers. Install Moonlight once on each device, then pair below.
        </Option>
        <Option title="Use the desktop" badge="Desktop mode" badgeCls="border-neon-cyan/50 text-neon-cyan"
          href={b?.desktop.url} cta="Open desktop" available={ready && b?.desktop.available} note={missing(b?.desktop) ? unavailable : 'Available once setup is ready.'}>
          The machine&apos;s desktop in any browser tab: install things, sign in to launchers, copy &amp; paste between your computer and the machine. About 30 fps: fine for desktop work, not for games.
        </Option>
        <Option title="Play in browser" badge="High performance · Experimental" badgeCls="border-neon-amber/50 text-neon-amber"
          href={b?.play.url} cta="Open player" available={ready && b?.play.available} note={missing(b?.play) ? unavailable : 'Available once setup is ready.'}>
          The full GPU stream, sound and controller in Chrome or Edge — no app to install. New and less proven than the Moonlight app: if it stutters or won&apos;t connect, use the app.
        </Option>
      </div>
      <p className="text-[0.7rem] text-slate-500 leading-relaxed">
        Both browser options sign in with this machine&apos;s <strong className="text-slate-300">username and password</strong> below.
        The first time, your browser warns about the certificate: choose <em>Advanced → Proceed</em>. It&apos;s the machine&apos;s own certificate and the connection is still encrypted.
        {' '}In the player, pick the machine, then an app (e.g. Desktop or Steam).
      </p>
    </div>
  );
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
      className="text-[0.7rem] uppercase tracking-label text-neon-cyan/70 hover:text-neon-cyan"
    >
      {copied ? 'copied ✓' : 'copy'}
    </button>
  );
}

export default function MachineConnectionPanel({
  machineId, status, quality = 'high', onStage, bigScreen = false, onResume, onStatusChange,
}: {
  /** Start / restart the machine so its setup carries on (POST …/resume-setup via the card). */
  onResume?: () => void;
  /** The backend found the machine in another state than the card shows (e.g. stopped). */
  onStatusChange?: (status: string) => void;
  /** EXPERIMENTAL GRID-driver machine (screens up to 4096x2160). */
  bigScreen?: boolean;
  machineId: string;
  status: string;
  /** The machine's streaming preset, so the Moonlight command matches it. */
  quality?: string;
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
        if (data.status !== status) onStatusChange?.(data.status);
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
  const s = info.setup;
  const ago = (iso?: string | null) => {
    if (!iso) return '';
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  };

  return (
    <div className="space-y-4 text-sm">
      {/* ---- Setup progress ---- */}
      {(info.status === 'running' || s.interrupted) && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="label">On-machine setup{s.stale && !s.ready && !s.failed && <span className="ml-2 normal-case tracking-normal text-slate-500">· last seen {ago(s.lastSeenAt)}</span>}</span>
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
          {s.stale && s.error && !s.interrupted && (
            <p className="text-xs text-neon-amber mt-1">! Lost contact with the machine’s console ({s.error}). Showing the last progress seen; retrying every 15 seconds.</p>
          )}
          {s.interrupted && (
            <div className="mt-2 rounded border border-neon-amber/40 bg-neon-amber/[0.05] p-3 text-xs space-y-2">
              <p className="text-neon-amber font-semibold">
                {info.status === 'stopped' ? `! Setup paused at ${pct}% — the machine stopped.`
                  : s.stuck ? `! Setup looks stuck at ${pct}% (no progress for 30+ minutes).`
                  : `! Setup at ${pct}% has gone quiet — can’t reach the machine’s console.`}
              </p>
              {s.stopReason && <p className="text-slate-300">{s.stopReason}</p>}
              {!s.stopReason && s.error && <p className="text-slate-400">The cloud said: {s.error}</p>}
              <p className="text-slate-400">
                Nothing is lost: the setup keeps its finished steps on the disk and carries on from where it got to.{' '}
                {info.status === 'stopped' ? 'Resume starts the machine again (billing resumes).' : 'Resume restarts the machine (a couple of minutes).'}
              </p>
              {onResume && (
                <button type="button" onClick={onResume} className="btn-neon-lime text-xs">↻ Resume setup</button>
              )}
            </div>
          )}
          {info.setup.failed && (
            <div className="text-xs text-slate-400 mt-1 space-y-2">
              <p>
                The setup stopped at the step above. The full log is on the machine at /var/log/cloudgaming-setup.log (open the machine
                in your cloud console and use its SSH / serial console button; for the streaming container, run: docker logs cloudy).
                Resume retries from the failed step (after a fix, e.g. a new app version); deleting and relaunching starts from scratch.
              </p>
              {onResume && <button type="button" onClick={onResume} className="btn-neon text-xs">↻ Retry setup (restart machine)</button>}
            </div>
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

      {/* ---- Which way to connect ---- */}
      {info.ipAddress && info.status === 'running' && <WaysToConnect info={info} />}

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
              <button type="button" onClick={() => setShowPassword((v) => !v)} className="text-[0.7rem] uppercase tracking-label text-neon-cyan/70 hover:text-neon-cyan">
                {showPassword ? 'hide' : 'show'}
              </button>
              <CopyButton value={info.password} />
            </>
          )}
        </dd>
      </dl>

      {/* ---- One-click pairing + ready-made Moonlight command ---- */}
      {info.ipAddress && info.status === 'running' && (
        <div className="rounded-md border border-neon-magenta/25 bg-neon-magenta/[0.03] p-4">
          <p className="text-sm font-semibold text-slate-100 mb-3">▶ Play with Moonlight</p>
          <MoonlightLauncher machineId={machineId} host={info.ipAddress} quality={quality} ready={info.setup.ready} bigScreen={bigScreen} />
        </div>
      )}

      {/* ---- Manual steps (phones/TVs, or if the command route doesn't suit) ---- */}
      <details>
        <summary className="label cursor-pointer">Manual steps (phones, TVs, or pairing by hand)</summary>
        <ol className="mt-2 list-decimal pl-5 space-y-1.5 text-xs text-slate-300 leading-relaxed">
          <li>Install <a href="https://moonlight-stream.org" target="_blank" rel="noopener noreferrer" className="text-neon-cyan hover:underline">Moonlight</a> on the device you'll play on (PC, Mac, phone, TV).</li>
          <li>In Moonlight, click <strong>+</strong> (Add PC) and enter the IP address above. Moonlight shows a 4-digit PIN.</li>
          <li>
            Open the Sunshine admin link above. Your browser will warn that the certificate is self-signed — that's expected for this
            machine; continue. Sign in with the username and password above.
          </li>
          <li>Go to <strong>PIN</strong>, type Moonlight's PIN, and submit. Moonlight is now paired (only needed once per device).</li>
          <li>In Moonlight, open the machine and pick an app: <strong>Steam</strong> / <strong>Steam (Big Picture)</strong>, <strong>Battle.net</strong>, <strong>Discord</strong>, <strong>Google Chrome</strong>, <strong>Heroic</strong> (Epic &amp; GOG), <strong>Lutris</strong>, <strong>Firefox</strong> or the whole <strong>Desktop</strong>. The first time you open Battle.net it runs its installer (click through once, a few minutes).</li>
          <li>Log in to each app once — logins stay on this machine through stops and restarts. Quickest: scan the <strong>QR code</strong> on the Steam, Discord or Battle.net login screen with their phone app.</li>
          <li>When you're done, <strong>stop</strong> the machine here so it stops billing. Your games stay on its disk. (If you set auto-stop at launch, it also shuts itself down after that long without streaming.)</li>
        </ol>
        <p className="mt-2 text-[0.7rem] text-slate-500">
          Note: after a stop/start the IP may change — if Moonlight can't find the machine, add the new IP. Games with kernel anti-cheat
          (e.g. Valorant, Fortnite) don&apos;t run on these Linux machines; most Steam games do, via Proton.
        </p>
      </details>
    </div>
  );
}
