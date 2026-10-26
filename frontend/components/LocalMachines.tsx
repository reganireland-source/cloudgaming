'use client';

/**
 * components/LocalMachines.tsx — YOUR OWN PCs (Windows + Sunshine), on the Machines page
 *
 * The cloud machines' sibling for a PC at home. A small agent on the PC connects
 * out to GGGH (nothing is opened on the PC's side); here you add the PC, run one
 * command on it, then:
 *   - see it online / offline, its address, GPU load, whether someone is streaming;
 *   - pair Moonlight (GGGH picks the PIN, the agent enters it into Sunshine);
 *   - sleep / restart / shut down, restart Sunshine;
 *   - match the PC's screen to the device you stream to (done by the Moonlight command);
 *   - run a PowerShell command (off until switched on per PC; every command is logged);
 *   - copy or download the terminal command that wakes the PC, matches its screen,
 *     streams, and puts the screen back (lib/localCommand.ts).
 * Reads/writes /api/local-machines (src/api/routes/localMachines.ts).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, type ApiError } from '@/lib/auth';
import { SCREENS, detectScreen, detectAllScreens, canListScreens, fitResolution, type AttachedScreen } from '@/lib/screens';
import LocalDiagnose from '@/components/LocalDiagnose';
import { sshAlias, sshSetupCommand } from '@/lib/sshHelper';
import {
  CONNECTIONS, LOCAL_APPS, buildCheckScript, buildLaunchScript, saveAndRunCommand, localBitrateKbps, pairCommand, plainStreamCommand,
  type LocalCodec, type LocalLaunch, type LocalMode, type LocalOS,
} from '@/lib/localCommand';

interface LocalMachine {
  id: string; name: string; lanIp: string | null; mac: string | null;
  online: boolean; lastSeenAt: string | null; scriptEnabled: boolean; displayMode: LocalMode;
  wanHost: string | null; awayOk: boolean; awayCheckedAt: string | null; sshEnabled: boolean;
  status: {
    publicIp?: string; myIp?: string;
    ssh?: { installed: boolean; running: boolean; port: number; user: string };
    away?: { upnp: string; webUi: string; profile: string };
    display?: { mode: LocalMode; virtual: boolean; virtualState?: string; seen?: string[] };
    host?: string; os?: string; uptimeHours?: number; cpuPercent?: number; ramGb?: number; ramFreeGb?: number;
    wired?: boolean; link?: string; streaming?: boolean; sunshine?: string; agentVersion?: string;
    gpu?: { name: string; util: number; tempC: number; encoders: number; vramUsedMb: number; vramTotalMb: number; driver: string };
  } | null;
  createdAt: string;
}
interface Cmd { id: string; kind: string; status: string; result: string | null }
interface CmdLogRow { id: string; kind: string; args: Record<string, unknown>; source: string; status: string; result: string | null; createdAt: string }

const timeAgo = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(iso).toLocaleDateString();
};
const errText = (e: unknown) => `${(e as ApiError)?.message || 'That didn’t work.'}${(e as ApiError)?.tip ? ` ${(e as ApiError).tip}` : ''}`;
const detectOS = (): LocalOS => {
  if (typeof navigator === 'undefined') return 'macos';
  const p = navigator.userAgent.toLowerCase();
  return p.includes('mac') ? 'macos' : p.includes('win') ? 'windows' : 'linux';
};

function CopyBox({ text, tall }: { text: string; tall?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className={`whitespace-pre-wrap break-all text-[0.72rem] font-mono text-neon-lime bg-black/40 border border-white/10 rounded p-3 pr-16 ${tall ? 'max-h-72 overflow-y-auto' : ''}`}>{text}</pre>
      <button type="button" className="absolute top-2 right-2 text-[0.7rem] uppercase tracking-label text-neon-cyan/80 hover:text-neon-cyan border border-neon-cyan/30 rounded px-2 py-0.5"
        onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* select by hand */ } }}>
        {copied ? 'copied ✓' : 'copy'}
      </button>
    </div>
  );
}

/** Follows one command until the PC has answered (or it gave up). */
async function followCommand(machineId: string, commandId: string, onUpdate: (c: Cmd) => void, stopRef: { current: boolean }) {
  for (let i = 0; i < 160 && !stopRef.current; i++) {
    try {
      const c = await apiFetch<Cmd>(`/local-machines/${machineId}/commands/${commandId}`);
      onUpdate(c);
      if (['done', 'failed', 'expired'].includes(c.status)) return c;
    } catch { /* try again */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="label">{label}</p><p className="text-xs text-slate-200 tabular-nums">{children}</p></div>;
}

function LocalCard({ m, onChanged }: { m: LocalMachine; onChanged: () => void }) {
  const stop = useRef(false);
  // Stop following commands when the card goes away (and start again if React remounts it, as in dev mode).
  useEffect(() => { stop.current = false; return () => { stop.current = true; }; }, []);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'sleep' | 'restart' | 'shutdown' | 'remove' | 'token' | null>(null);
  const [pair, setPair] = useState<{ pin: string; host: string | null; status: string; result: string | null } | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [panel, setPanel] = useState<'launch' | 'diagnose' | 'settings' | 'log' | null>(null);
  const st = m.status;

  const send = async (kind: string, args?: Record<string, unknown>, label?: string) => {
    setBusy(kind); setNote(null);
    try {
      const c = await apiFetch<{ id: string }>(`/local-machines/${m.id}/commands`, { method: 'POST', body: { kind, args } });
      const done = await followCommand(m.id, c.id, () => undefined, stop);
      setNote({ ok: done?.status === 'done', text: done ? (done.result || done.status) : `${label || kind}: no answer yet — is the PC on?` });
      onChanged();
    } catch (e) { setNote({ ok: false, text: errText(e) }); } finally { setBusy(null); setConfirm(null); }
  };

  const startPairing = async () => {
    setBusy('pair'); setNote(null);
    try {
      const r = await apiFetch<{ commandId: string; pin: string; host: string | null }>(`/local-machines/${m.id}/pair`, { method: 'POST' });
      setPair({ pin: r.pin, host: r.host, status: 'sent', result: null });
      const done = await followCommand(m.id, r.commandId, (c) => setPair((p) => (p ? { ...p, status: c.status, result: c.result } : p)), stop);
      if (done?.status === 'done') onChanged();
    } catch (e) { setNote({ ok: false, text: errText(e) }); } finally { setBusy(null); }
  };

  const remove = async () => {
    setBusy('remove');
    try { await apiFetch(`/local-machines/${m.id}`, { method: 'DELETE' }); onChanged(); } catch (e) { setNote({ ok: false, text: errText(e) }); setBusy(null); }
  };
  const rotate = async () => {
    setBusy('token');
    try { const r = await apiFetch<{ installCommand: string }>(`/local-machines/${m.id}/token`, { method: 'POST' }); setNewToken(r.installCommand); setConfirm(null); }
    catch (e) { setNote({ ok: false, text: errText(e) }); } finally { setBusy(null); }
  };

  const off = !m.online;
  const btn = 'btn-neon text-xs disabled:opacity-40';
  return (
    <div className="neon-card rounded-lg border border-white/10 p-4 sm:p-5 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`text-[0.7rem] uppercase tracking-label border rounded px-2 py-0.5 ${m.online ? 'border-neon-lime/60 text-neon-lime' : 'border-white/20 text-slate-400'}`}>{m.online ? 'online' : 'offline'}</span>
        <span className="text-sm font-semibold text-slate-100">{m.name}</span>
        {st?.streaming && <span className="text-[0.66rem] uppercase tracking-label border border-neon-magenta/60 text-neon-magenta rounded px-1.5">streaming now</span>}
        <span className="text-xs text-slate-500">{m.online ? 'connected to GGGH' : `last seen ${timeAgo(m.lastSeenAt)}`}{st?.os ? ` · ${st.os}` : ''}</span>
      </div>

      {m.lastSeenAt && (
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          <Stat label="Address">{m.lanIp || '—'}{st?.wired === false ? <span className="text-neon-amber"> · Wi-Fi</span> : st?.wired ? ' · wired' : ''}</Stat>
          {st?.gpu && <Stat label="GPU">{st.gpu.name.replace('NVIDIA GeForce ', '')} · {st.gpu.util}% · {st.gpu.tempC}°C</Stat>}
          {st?.cpuPercent != null && <Stat label="CPU">{st.cpuPercent}%</Stat>}
          {st?.ramGb != null && <Stat label="Memory">{(st.ramGb - (st.ramFreeGb || 0)).toFixed(1)}/{st.ramGb} GB</Stat>}
          <Stat label="Sunshine"><span className={st?.sunshine === 'Running' ? 'text-neon-lime' : 'text-neon-amber'}>{st?.sunshine === 'NotInstalled' ? 'not installed' : (st?.sunshine || '—').toLowerCase()}</span></Stat>
          {st?.display && <Stat label="Screens">{st.display.mode === 'headless' ? <span className="text-neon-cyan">headless · virtual display</span> : 'mirror · own screens on'}{!st.display.virtual && <span className="text-slate-500"> · no virtual display yet</span>}</Stat>}
          {st?.agentVersion && <Stat label="Agent">v{st.agentVersion} <span className="text-slate-500">updates itself</span></Stat>}
          {st?.uptimeHours != null && <Stat label="Up for">{st.uptimeHours < 48 ? `${st.uptimeHours} h` : `${Math.round(st.uptimeHours / 24)} days`}</Stat>}
        </div>
      )}
      {off && m.lastSeenAt && <p className="text-xs text-slate-500">The PC is off, asleep or can’t reach GGGH. The Moonlight command below can wake it if Wake-on-LAN is on.</p>}
      {!m.lastSeenAt && <p className="text-xs text-neon-amber">Not connected yet — run the install command on the PC (see “Settings”).</p>}

      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={off || !!busy} onClick={startPairing}>Pair Moonlight</button>
        <button type="button" className={btn} disabled={off || !!busy} onClick={() => send('sunshine-restart', undefined, 'Restart Sunshine')}>Restart Sunshine</button>
        <button type="button" className={btn} disabled={off || !!busy} onClick={() => send('refresh')}>Refresh</button>
        {st?.display?.mode === 'headless' && <button type="button" className={btn} disabled={off || !!busy} onClick={() => send('display-restore', undefined, 'Screens back on')}>Screens back on</button>}
        <button type="button" className="btn-neon text-xs disabled:opacity-40" disabled={off || !!busy} onClick={() => setConfirm('sleep')}>Sleep</button>
        <button type="button" className="btn-neon text-xs disabled:opacity-40" disabled={off || !!busy} onClick={() => setConfirm('restart')}>Restart PC</button>
        <button type="button" className="btn-neon-pink text-xs disabled:opacity-40" disabled={off || !!busy} onClick={() => setConfirm('shutdown')}>Shut down</button>
      </div>

      {(confirm === 'sleep' || confirm === 'restart' || confirm === 'shutdown') && (
        <div className="rounded border border-neon-pink/30 p-3 text-xs text-slate-300 space-y-2">
          <p>
            {confirm === 'sleep' && <>Put {m.name} to sleep? Anyone streaming is disconnected. You can wake it with the Moonlight command (Wake-on-LAN).</>}
            {confirm === 'restart' && <>Restart {m.name}? Anyone streaming is disconnected; it’s back in a minute or two.</>}
            {confirm === 'shutdown' && <>Shut {m.name} down? It stays off until someone presses its power button. (Sleep keeps it wakeable from here.)</>}
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-neon-pink text-xs" disabled={!!busy} onClick={() => send(confirm)}>{confirm === 'sleep' ? 'Sleep' : confirm === 'restart' ? 'Restart' : 'Shut down'}</button>
            <button type="button" className="text-slate-400 hover:text-slate-200 px-2" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}

      {pair && (
        <div className={`rounded border p-3 text-xs space-y-2 ${pair.status === 'done' ? 'border-neon-lime/40' : pair.status === 'failed' || pair.status === 'expired' ? 'border-neon-pink/40' : 'border-neon-cyan/30'}`}>
          {pair.status === 'done' ? <p className="text-neon-lime">✓ {pair.result}</p>
            : pair.status === 'failed' || pair.status === 'expired' ? <p className="text-neon-pink">{pair.result || 'Pairing didn’t finish.'} Press “Pair Moonlight” for a fresh PIN.</p>
            : <>
              <p className="text-slate-200">Run this on the device you stream to (within about 2 minutes). The PC enters the PIN into Sunshine by itself.</p>
              <CopyBox text={pairCommand(detectOS(), pair.host || m.lanIp || '<the PC’s address>', pair.pin)} />
              <p className="text-slate-500 animate-pulse">Waiting for Moonlight to start pairing…</p>
            </>}
        </div>
      )}
      {note && <p role="status" className={`text-xs whitespace-pre-wrap break-words ${note.ok ? 'text-neon-lime' : 'text-neon-amber'}`}>{note.ok ? '✓ ' : '⚠ '}{note.text}</p>}

      <div className="flex gap-1 border-b border-white/5">
        {(['launch', 'diagnose', 'settings', 'log'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setPanel(panel === t ? null : t)}
            className={`px-3 py-1.5 text-[0.72rem] uppercase tracking-label border-b-2 -mb-px ${panel === t ? 'border-neon-cyan text-neon-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {{ launch: 'Moonlight command', diagnose: 'Diagnose', settings: 'Settings', log: 'Command log' }[t]}
          </button>
        ))}
      </div>

      {panel === 'launch' && <LaunchPanel m={m} />}
      {panel === 'diagnose' && <LocalDiagnose id={m.id} name={m.name} online={m.online} />}
      {panel === 'settings' && (
        <SettingsPanel m={m} onChanged={onChanged} busy={busy} newToken={newToken}
          askToken={() => setConfirm('token')} askRemove={() => setConfirm('remove')}
          runScript={(script) => send('script', { script }, 'Script')}
          runCommand={(kind, args, label) => send(kind, args, label)} />
      )}
      {panel === 'log' && <LogPanel id={m.id} />}

      {confirm === 'token' && (
        <div className="rounded border border-neon-amber/30 p-3 text-xs text-slate-300 space-y-2">
          <p>Make a new install command? The one on the PC now stops working; run the new one on the PC to reconnect it.</p>
          <div className="flex gap-2"><button type="button" className="btn-neon text-xs" disabled={!!busy} onClick={rotate}>Make a new one</button><button type="button" className="text-slate-400 hover:text-slate-200 px-2" onClick={() => setConfirm(null)}>Cancel</button></div>
        </div>
      )}
      {confirm === 'remove' && (
        <div className="rounded border border-red-600/40 p-3 text-xs text-slate-300 space-y-2">
          <p><strong className="text-red-400">Remove {m.name} from GGGH?</strong> The PC itself is untouched (its agent just stops being able to connect; uninstall it there with the “GGGH Agent” and “GGGH Display” scheduled tasks if you like).</p>
          <div className="flex gap-2"><button type="button" className="text-xs border border-red-600 text-red-300 rounded px-3 py-1.5 hover:bg-red-950/40" disabled={!!busy} onClick={remove}>Yes, remove it</button><button type="button" className="text-slate-400 hover:text-slate-200 px-2" onClick={() => setConfirm(null)}>Cancel</button></div>
        </div>
      )}
    </div>
  );
}

function LaunchPanel({ m }: { m: LocalMachine }) {
  const [info, setInfo] = useState<{ launcherToken: string; lanIp: string | null; mac: string | null; api: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { apiFetch<NonNullable<typeof info>>(`/local-machines/${m.id}/launcher`).then(setInfo).catch((e) => setErr(errText(e))); }, [m.id, m.lanIp, m.mac]);

  const [os, setOs] = useState<LocalOS>('macos');
  useEffect(() => setOs(detectOS()), []);
  const [app, setApp] = useState(LOCAL_APPS[0]);
  const [screenId, setScreenId] = useState('this');
  const [attached, setAttached] = useState<AttachedScreen[] | null>(null);
  const [listTried, setListTried] = useState(false);
  const findScreens = async () => { setListTried(true); setAttached(await detectAllScreens(true)); };
  useEffect(() => { detectAllScreens(false).then((l) => l && setAttached(l)); }, []);
  const [thisScreen, setThisScreen] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => setThisScreen(detectScreen()), []);
  const [fps, setFps] = useState(60);
  const [codec, setCodec] = useState<LocalCodec>('HEVC');
  const [fullscreen, setFullscreen] = useState(true);
  const [wake, setWake] = useState(true);
  const [mode, setMode] = useState<LocalMode>(m.displayMode || 'mirror');
  useEffect(() => setMode(m.displayMode || 'mirror'), [m.displayMode]);
  const chooseMode = (v: LocalMode) => {
    setMode(v); // the choice is also kept as this PC's default
    apiFetch(`/local-machines/${m.id}`, { method: 'PATCH', body: { displayMode: v } }).catch(() => undefined);
  };
  const [overlay, setOverlay] = useState(true);
  const [muteHere, setMuteHere] = useState(true);
  const [connection, setConnection] = useState('best');

  const picked = screenId.startsWith('attached:') ? attached?.find((x) => `attached:${x.key}` === screenId) : undefined;
  const screen = picked || (screenId === 'this' ? (thisScreen || { w: 1920, h: 1080 }) : (SCREENS.find((s) => s.id === screenId) || { w: 1920, h: 1080 }));
  const conn = CONNECTIONS.find((c) => c.id === connection);
  const res = conn ? fitResolution(screen, conn.pixels, 3840, 2160) : fitResolution(screen, screen.w * screen.h, 3840, 2160);
  const useFps = conn ? conn.fps : fps;
  const useCodec: LocalCodec = conn ? conn.codec : codec;
  const useKbps = conn ? conn.bitrateKbps : localBitrateKbps(res.w, res.h, fps);
  const host = info?.lanIp || m.lanIp;
  const mac = info?.mac || m.mac;
  const launch: LocalLaunch | null = info && host ? {
    os, name: m.name, host, mac, app, width: res.w, height: res.h, fps: useFps, bitrateKbps: useKbps, codec: useCodec, fullscreen,
    wake: wake && !!mac, mode, muteHere, overlay, away: m.awayOk, target: picked?.target ?? null, api: info.api, token: info.launcherToken,
  } : null;
  const script = useMemo(() => (launch ? buildLaunchScript(launch) : ''), [launch ? JSON.stringify(launch) : '']); // eslint-disable-line react-hooks/exhaustive-deps

  const sel = 'input-neon px-2 py-1 text-xs';
  if (err) return <p className="text-xs text-neon-amber">⚠ {err}</p>;
  if (!host || !launch) return <p className="text-xs text-slate-500">{host ? 'Loading…' : 'Waiting for the PC to report its address (it connects within a few seconds of the install command finishing).'}</p>;
  return (
    <div className="space-y-3 text-xs">
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="space-y-1"><span className="label">Connection</span>
          <select className={`${sel} w-full`} value={connection} onChange={(e) => setConnection(e.target.value)}>
            <option value="best">Best · follows my screen (home network)</option>
            {CONNECTIONS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <label className="space-y-1"><span className="label">Stream</span>
          <select className={`${sel} w-full`} value={app} onChange={(e) => setApp(e.target.value)}>{LOCAL_APPS.map((a) => <option key={a}>{a}</option>)}</select></label>
        <label className="space-y-1"><span className="label">Your screen</span>
          <select className={`${sel} w-full`} value={screenId} onChange={(e) => setScreenId(e.target.value)}>
            <option value="this">This screen ({thisScreen ? `${thisScreen.w}×${thisScreen.h}` : '…'})</option>
            {(attached || []).length > 0 && <optgroup label="Your displays">{(attached || []).map((x) => <option key={x.key} value={`attached:${x.key}`}>{x.label} ({x.w}×{x.h}){x.primary ? ' · main' : ''}</option>)}</optgroup>}
            {SCREENS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select></label>
        <label className="space-y-1"><span className="label">Frame rate</span>
          <select className={`${sel} w-full`} value={useFps} disabled={!!conn} onChange={(e) => setFps(Number(e.target.value))}>{[30, 60, 90, 120].map((f) => <option key={f} value={f}>{f} fps</option>)}</select></label>
        <label className="space-y-1"><span className="label">Video</span>
          <select className={`${sel} w-full`} value={useCodec} disabled={!!conn} onChange={(e) => setCodec(e.target.value as LocalCodec)}>
            <option value="HEVC">HEVC (best for most)</option><option value="H.264">H.264 (oldest, most compatible)</option><option value="AV1">AV1 (RTX 40/50 only)</option></select></label>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-slate-300">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={fullscreen} onChange={(e) => setFullscreen(e.target.checked)} /> Full screen</label>
        <label className={`flex items-center gap-1.5 ${mac ? '' : 'opacity-50'}`} title={mac ? undefined : 'Needs the PC’s MAC address (Settings)'}><input type="checkbox" checked={wake && !!mac} disabled={!mac} onChange={(e) => setWake(e.target.checked)} /> Wake the PC first</label>
        {mode === 'mirror' && os === 'macos' && <label className="flex items-center gap-1.5" title="The PC plays its own sound in Mirror mode; Moonlight still sends a copy here, so this computer is muted for the stream and un-muted afterwards"><input type="checkbox" checked={muteHere} onChange={(e) => setMuteHere(e.target.checked)} /> Mute this computer while streaming</label>}
        <label className="flex items-center gap-1.5" title="Moonlight draws decode time, dropped frames and network delay over the stream: the first thing to look at when it lags"><input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} /> Show Moonlight’s performance overlay</label>
        <label className="flex items-center gap-1.5">Run it on
          <select className={sel} value={os} onChange={(e) => setOs(e.target.value as LocalOS)}><option value="macos">macOS</option><option value="linux">Linux</option><option value="windows">Windows</option></select></label>
      </div>
      <div className={`grid sm:grid-cols-2 gap-3 ${os === 'windows' ? 'opacity-50' : ''}`}>
        {([
          ['mirror', 'Mirror (control)', 'The PC’s own screens stay on at their own resolution, its sound keeps playing from the PC’s own speakers, and its desktop shows here (this computer is muted). For setting things up. Speed matters less.'],
          ['headless', 'Headless (gaming)', 'The PC’s screens switch off and a virtual display takes over at this screen’s size and refresh rate, with the stream tuned for play. The PC’s speakers are muted and the sound plays here. Everything comes back when you stop.'],
        ] as const).map(([v, title, text]) => (
          <label key={v} className={`flex items-start gap-2 rounded border p-3 cursor-pointer ${mode === v ? 'border-neon-cyan/60 bg-neon-cyan/5' : 'border-white/10 hover:border-white/25'}`}>
            <input type="radio" name={`mode-${m.id}`} className="mt-0.5" checked={mode === v} disabled={os === 'windows'} onChange={() => chooseMode(v)} />
            <span><span className="block text-slate-100 font-semibold">{title}</span><span className="block text-slate-400">{text}</span></span>
          </label>
        ))}
      </div>
      {mode === 'headless' && os !== 'windows' && m.status?.display && !m.status.display.virtual && (
        <p className="text-neon-amber">⚠ This PC has no virtual display yet, so Headless can’t switch its screens off. Install one under Settings → Virtual display first (until then it streams as Mirror).{m.status.display.seen?.length ? ` Windows lists these display devices: ${m.status.display.seen.join(', ')}.` : ''}</p>
      )}
      <p className="text-slate-500">
        More than one monitor? Moonlight opens on the display where Terminal is, so pick the display you’ll play on: on a Mac (Terminal or iTerm2) the command moves the Terminal window there first, then moves it back.
        {attached ? <> {attached.length} display{attached.length === 1 ? '' : 's'} found.</>
          : canListScreens() ? <> <button type="button" className="text-neon-cyan hover:underline" onClick={findScreens}>Find my other displays</button>{listTried && ' (permission refused: allow “window management” for this site in the browser)'}</>
          : <> This browser can only see its own screen; Chrome or Edge can list every display.</>}
      </p>
      {conn && <p className="text-neon-cyan">{conn.label.split(' · ')[0]} connection: for {conn.hint}. Frame rate and video format are set by this choice. It saves as its own launcher file, so it can sit beside your normal one.</p>}
      <p className="text-slate-500">Stream {res.w}×{res.h} at {useFps} fps, about {Math.round((useKbps / 1000) * 10) / 10} Mbit/s{conn ? '' : ' over your home network'}. Needs Moonlight installed and paired (Pair Moonlight above).</p>
      {os === 'windows'
        ? <><CopyBox text={plainStreamCommand(launch)} /><p className="text-slate-500">Paste into Command Prompt. (Waking and the Mirror / Headless switch are for the macOS and Linux command.)</p></>
        : <>
          <p className="text-slate-300">Paste this into Terminal. It saves the launcher as a file on this computer and runs it. (A downloaded file is blocked by macOS, but one made in Terminal isn’t.)</p>
          <CopyBox text={saveAndRunCommand(`moonlight-${m.name}-${app}${conn ? `-${conn.id}` : ''}.sh`, script)} tall />
          <details className="text-slate-500"><summary className="cursor-pointer">What does that command contain?</summary><div className="pt-2"><CopyBox text={script} tall /></div></details>
          <p className="text-slate-500">After that, start it any time with the path it prints. Streaming needs only the PC’s address, so it works even if GGGH is down (the screen steps just get skipped).</p>
          <p className="text-slate-300 pt-1">Laggy? Check this computer’s side of the connection (20 seconds: Wi-Fi or cable, lost pings):</p>
          <CopyBox text={saveAndRunCommand(`check-connection-to-${m.name}.sh`, buildCheckScript(host || ''))} />
          <p className="text-slate-500">The file holds a key that can only ask this PC to match its screen: it can’t switch it off or run anything. Keep it to yourself like a password.</p>
        </>}
    </div>
  );
}

function SettingsPanel({ m, onChanged, busy, newToken, askToken, askRemove, runScript, runCommand }: {
  m: LocalMachine; onChanged: () => void; busy: string | null; newToken: string | null;
  askToken: () => void; askRemove: () => void; runScript: (script: string) => void;
  runCommand: (kind: string, args?: Record<string, unknown>, label?: string) => void;
}) {
  const [name, setName] = useState(m.name);
  const [ip, setIp] = useState(m.lanIp || '');
  const [mac, setMac] = useState(m.mac || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [script, setScript] = useState('');
  const dirty = name !== m.name || ip !== (m.lanIp || '') || mac !== (m.mac || '');
  const save = async () => {
    setSaving(true); setMsg(null);
    try { await apiFetch(`/local-machines/${m.id}`, { method: 'PATCH', body: { name, lanIp: ip, mac } }); setMsg('Saved.'); onChanged(); } catch (e) { setMsg(`⚠ ${errText(e)}`); } finally { setSaving(false); }
  };
  const [vdCmd, setVdCmd] = useState<string | null>(null);
  const [launcher, setLauncher] = useState<{ api: string; launcherToken: string } | null>(null);
  useEffect(() => { apiFetch<{ api: string; launcherToken: string }>(`/local-machines/${m.id}/launcher`).then((i) => { setLauncher(i); setVdCmd(`irm '${i.api}/local-agent/virtual-display.ps1' | iex`); }).catch(() => undefined); }, [m.id]);
  const [wan, setWan] = useState(m.wanHost || '');
  useEffect(() => setWan(m.wanHost || ''), [m.wanHost]);
  const [awayBusy, setAwayBusy] = useState(false);
  const [awayMsg, setAwayMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const saveWan = async () => {
    try { await apiFetch(`/local-machines/${m.id}`, { method: 'PATCH', body: { wanHost: wan } }); setAwayMsg({ ok: true, text: 'Saved. Test it again.' }); onChanged(); } catch (e) { setAwayMsg({ ok: false, text: errText(e) }); }
  };
  const testAway = async () => {
    setAwayBusy(true); setAwayMsg(null);
    try { const r = await apiFetch<{ ok: boolean; message: string }>(`/local-machines/${m.id}/away-check`, { method: 'POST' }); setAwayMsg({ ok: r.ok, text: r.message }); onChanged(); } catch (e) { setAwayMsg({ ok: false, text: errText(e) }); } finally { setAwayBusy(false); }
  };
  const [sshOn, setSshOn] = useState(m.sshEnabled);
  useEffect(() => setSshOn(m.sshEnabled), [m.sshEnabled]);
  const toggleSsh = async (on: boolean) => {
    setSshOn(on);
    try { await apiFetch(`/local-machines/${m.id}`, { method: 'PATCH', body: { sshEnabled: on } }); onChanged(); } catch (e) { setSshOn(!on); setMsg(`⚠ ${errText(e)}`); }
  };
  const [scriptOn, setScriptOn] = useState(m.scriptEnabled);
  useEffect(() => setScriptOn(m.scriptEnabled), [m.scriptEnabled]);
  const toggleScript = async (on: boolean) => {
    setScriptOn(on); // shows at once; goes back if the server says no
    try { await apiFetch(`/local-machines/${m.id}`, { method: 'PATCH', body: { scriptEnabled: on } }); onChanged(); } catch (e) { setScriptOn(!on); setMsg(`⚠ ${errText(e)}`); }
  };
  const inp = 'input-neon px-2 py-1 text-xs w-full';
  return (
    <div className="space-y-4 text-xs">
      <div className="grid sm:grid-cols-3 gap-3">
        <label className="space-y-1"><span className="label">Name</span><input className={inp} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
        <label className="space-y-1"><span className="label">Address (the PC fills this in)</span><input className={inp} value={ip} placeholder="192.168.1.20" onChange={(e) => setIp(e.target.value)} /></label>
        <label className="space-y-1"><span className="label">MAC address (for waking it)</span><input className={inp} value={mac} placeholder="AA:BB:CC:DD:EE:FF" onChange={(e) => setMac(e.target.value)} /></label>
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className="btn-neon text-xs disabled:opacity-40" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        {msg && <span className={msg.startsWith('⚠') ? 'text-neon-amber' : 'text-neon-lime'}>{msg}</span>}
      </div>

      <div className="space-y-2 border-t border-white/5 pt-3">
        <p className="label">Connect the PC</p>
        <p className="text-slate-400">On the PC (Windows 11), right-click Start → Terminal (Admin), paste the command and press Enter. It installs Sunshine if needed, sets Sunshine’s login (only the PC keeps it), turns on Wake-on-LAN and starts the agent.</p>
        {newToken ? <CopyBox text={newToken} /> : <p className="text-slate-500">The command is shown once, when the PC is added. Lost it? <button type="button" className="text-neon-cyan hover:underline" onClick={askToken}>Make a new one</button> (the old one stops working).</p>}
      </div>

      <div className="space-y-2 border-t border-white/5 pt-3">
        <p className="label">Virtual display (for Headless mode)</p>
        <p className="text-slate-400">Headless mode switches the PC’s own screens off, and Windows still needs <em>a</em> screen to stream from. This installs a software one (the open-source Virtual Display Driver). Same place as before: Terminal (Admin) on the PC.</p>
        {vdCmd ? <CopyBox text={vdCmd} /> : <p className="text-slate-500">Loading…</p>}
        <p className="text-slate-500">{m.status?.display?.virtual ? '✓ The PC reports a virtual display.' : `The PC does not report one yet. After installing, press Refresh on the PC card.${m.status?.display?.virtualState ? ` (State: ${m.status.display.virtualState}.)` : ''}${m.status?.display?.seen?.length ? ` Windows lists these display devices: ${m.status.display.seen.join(', ')}.` : ''}`} Safety net: if GGGH can’t be reached for 5 minutes, nobody has streamed for 10, or the PC restarts, the agent puts the screens back by itself. “Screens back on” on the PC card does it at once.</p>
      </div>

      <div className="space-y-2 border-t border-white/5 pt-3">
        <p className="label">Away from home: Moonlight over the internet</p>
        <p className="text-slate-400">Moonlight streams straight from the PC, so away from home your router has to let it in. 1) Prepare the PC (this restarts Sunshine, so it ends any stream in progress; Sunshine then asks the router to open its ports with UPnP; its admin page stays home-only). 2) Test from the internet. When that passes, the Moonlight command tries the home address first and otherwise asks GGGH for the current internet address, with a lower bitrate.</p>
        <div className="flex flex-wrap gap-2 items-center">
          <button type="button" className="btn-neon text-xs disabled:opacity-40" disabled={!m.online || !!busy} title="Restarts Sunshine, which ends any stream in progress" onClick={() => runCommand('away-prepare', undefined, 'Prepare for away access')}>1. Prepare the PC</button>
          <button type="button" className="btn-neon text-xs disabled:opacity-40" disabled={!m.online || !!busy} title="Asks the PC what its router and network say (UPnP, route, IPv6, firewall)" onClick={() => runCommand('away-diagnose', undefined, 'Away diagnostics')}>Diagnose</button>
          <button type="button" className="btn-neon text-xs disabled:opacity-40" disabled={awayBusy || !(m.wanHost || m.status?.myIp || m.status?.publicIp)} onClick={testAway}>{awayBusy ? 'Testing…' : '2. Test from the internet'}</button>
          {m.awayOk && <span className="text-neon-lime">✓ reachable{m.awayCheckedAt ? ` (tested ${timeAgo(m.awayCheckedAt)})` : ''}</span>}
        </div>
        <p className="text-slate-500">
          Internet address GGGH sees for this PC: <span className="text-slate-300 tabular-nums">{m.wanHost || m.status?.myIp || m.status?.publicIp || 'not known yet'}</span>.
          {m.status?.away && <> UPnP in Sunshine: <span className="text-slate-300">{m.status.away.upnp || 'off'}</span> · admin page: <span className="text-slate-300">{m.status.away.webUi || 'default'}</span> · network type: <span className="text-slate-300">{m.status.away.profile || '?'}</span>.</>}
          {' '}Compare that address with the “internet / WAN address” on your router’s status page: if they differ (or the router’s starts with 100.64 to 100.127) your provider shares one address between customers and a stream can’t reach you.
        </p>
        <div className="flex flex-wrap gap-2 items-center">
          <input className={`${inp} max-w-xs`} value={wan} placeholder="Use another address or name (optional)" onChange={(e) => setWan(e.target.value)} aria-label="Another internet address or name" />
          <button type="button" className="btn-neon text-xs disabled:opacity-40" disabled={wan.trim().toLowerCase() === (m.wanHost || '')} onClick={saveWan}>Save</button>
          <span className="text-slate-500">For a dynamic-DNS name or an IPv6 address.</span>
        </div>
        {awayMsg && <p role="status" className={awayMsg.ok ? 'text-neon-lime' : 'text-neon-amber'}>{awayMsg.ok ? '✓ ' : '⚠ '}{awayMsg.text}</p>}
        <p className="text-slate-500">If the router has no UPnP, forward these to the PC by hand: TCP 47984, 47989, 48010 and UDP 47998, 47999, 48000, 48002, 48010. Never forward 47990 (the admin page).</p>
      </div>

      <div className="space-y-2 border-t border-white/5 pt-3">
        <p className="label">SSH from anywhere</p>
        <label className="flex items-start gap-2 text-slate-300">
          <input type="checkbox" className="mt-0.5" checked={sshOn} onChange={(e) => toggleSsh(e.target.checked)} />
          <span>Allow SSH to this PC through GGGH. No router changes, and it works even if your provider shares one address. The PC dials out to GGGH; GGGH only relays the encrypted SSH traffic, and the PC’s own SSH server still checks your key.</span>
        </label>
        {sshOn && (
          <>
            <p className="text-slate-500">
              The PC reports: {m.status?.ssh ? (m.status.ssh.running ? `SSH server running on port ${m.status.ssh.port}` : m.status.ssh.installed ? 'SSH server installed but stopped' : 'no SSH server yet') : 'nothing yet (update the agent first)'}{m.status?.ssh?.user ? ` · signed-in user ${m.status.ssh.user}` : ''}.
            </p>
            <div className="flex flex-wrap gap-2 items-center">
              <button type="button" className="btn-neon text-xs disabled:opacity-40" disabled={!m.online || !!busy} onClick={() => runCommand('ssh-setup', undefined, 'Set up SSH')}>Set up SSH on the PC</button>
              <button type="button" className="btn-neon text-xs disabled:opacity-40" disabled={!m.online || !!busy} title="Asks the PC about its SSH server: service, port, who it listens to, keys, recent errors" onClick={() => runCommand('ssh-diagnose', undefined, 'SSH diagnostics')}>Diagnose SSH</button>
              <span className="text-slate-500">Adds the OpenSSH server if it’s missing, starts it, and adds the public keys saved on the Machines page (SSH access). Anything already there is left alone.</span>
            </div>
            {launcher
              ? <>
                <p className="text-slate-300">Then paste this into Terminal on the computer you’ll connect from. It saves a small helper and an entry in ~/.ssh/config:</p>
                <CopyBox text={sshSetupCommand({ api: launcher.api, token: launcher.launcherToken, name: m.name, user: m.status?.ssh?.user || '' })} />
                <p className="text-slate-500">After that: <span className="font-mono text-slate-300">ssh {sshAlias(m.name)}</span>, at home or away. The helper holds this PC’s key (it can only open SSH to this PC), so keep it private.</p>
              </>
              : <p className="text-slate-500">Loading…</p>}
          </>
        )}
      </div>

      <div className="space-y-2 border-t border-white/5 pt-3">
        <p className="label">Run a PowerShell command</p>
        <label className="flex items-start gap-2 text-slate-300">
          <input type="checkbox" className="mt-0.5" checked={scriptOn} onChange={(e) => toggleScript(e.target.checked)} />
          <span>Allow it for this PC. Commands run as administrator on the PC. Anyone who gets into your GGGH account could use this, so keep it off unless you need it. Every command is kept in the command log.</span>
        </label>
        {scriptOn && (
          <>
            <textarea className={`${inp} font-mono h-20`} value={script} maxLength={4000} placeholder="Get-Date" onChange={(e) => setScript(e.target.value)} />
            <button type="button" className="btn-neon text-xs disabled:opacity-40" disabled={!m.online || !script.trim() || !!busy} onClick={() => runScript(script)}>Run on {m.name}</button>
            <p className="text-slate-500">The answer appears above, and in the command log. It stops after 60 seconds.</p>
          </>
        )}
      </div>

      <div className="border-t border-white/5 pt-3">
        <button type="button" className="text-red-400 hover:text-red-300" onClick={askRemove}>Remove this PC from GGGH…</button>
      </div>
    </div>
  );
}

function LogPanel({ id }: { id: string }) {
  const [rows, setRows] = useState<CmdLogRow[] | null>(null);
  useEffect(() => { apiFetch<CmdLogRow[]>(`/local-machines/${id}/commands?limit=25`).then(setRows).catch(() => setRows([])); }, [id]);
  const show = (r: CmdLogRow) => (r.kind === 'script' ? `script: ${String((r.args as any).script || '').slice(0, 160)}` : r.kind === 'sunshine-pin' ? 'pair Moonlight' : r.kind === 'display-set' ? `match screen ${(r.args as any).width}×${(r.args as any).height}` : r.kind === 'display-headless' ? `headless ${(r.args as any).width}×${(r.args as any).height}` : r.kind === 'display-restore' ? 'screens back on' : r.kind.replace('-', ' '));
  if (!rows) return <p className="text-xs text-slate-500 animate-pulse">&gt; loading…</p>;
  if (!rows.length) return <p className="text-xs text-slate-500">Nothing has been asked of this PC yet.</p>;
  return (
    <ul className="divide-y divide-white/5 text-xs">
      {rows.map((r) => (
        <li key={r.id} className="py-1.5 flex gap-3">
          <span className={r.status === 'done' ? 'text-neon-lime' : r.status === 'queued' || r.status === 'sent' ? 'text-neon-amber' : 'text-neon-pink'}>{r.status === 'done' ? '✓' : r.status === 'queued' || r.status === 'sent' ? '…' : '✗'}</span>
          <div className="min-w-0 flex-1"><p className="text-slate-200 break-words">{show(r)} <span className="text-slate-500">· from {r.source === 'launcher' ? 'a Moonlight command' : 'the app'}</span></p>{r.result && <p className="text-slate-500 break-words">{r.result}</p>}</div>
          <span className="text-slate-500 shrink-0">{timeAgo(r.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function LocalMachines() {
  const [list, setList] = useState<LocalMachine[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [mac, setMac] = useState('');
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string; installCommand: string } | null>(null);

  const load = useCallback(() => {
    apiFetch<LocalMachine[]>('/local-machines').then((l) => { setList(l); setLoadError(null); }).catch((e) => setLoadError(errText(e)));
  }, []);
  const waiting = !!created && !!list?.find((x) => x.id === created.id && !x.lastSeenAt);
  useEffect(() => { load(); const t = setInterval(load, waiting ? 3000 : 10000); return () => clearInterval(t); }, [load, waiting]);

  const add = async () => {
    setSaving(true); setFormErr(null);
    try {
      const r = await apiFetch<{ machine: LocalMachine; installCommand: string }>('/local-machines', { method: 'POST', body: { name, mac: mac || undefined } });
      setCreated({ id: r.machine.id, name: r.machine.name, installCommand: r.installCommand });
      setAdding(false); setName(''); setMac(''); load();
    } catch (e) { setFormErr(errText(e)); } finally { setSaving(false); }
  };
  const createdMachine = created && list?.find((x) => x.id === created.id);
  const connected = !!createdMachine?.lastSeenAt;

  return (
    <section className="space-y-3" aria-label="Local machines">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="label">Local machines <span className="normal-case tracking-normal text-slate-500">— a PC at home that you control from here</span></h2>
        {!adding && <button type="button" className="btn-neon text-xs" onClick={() => { setAdding(true); setCreated(null); }}>+ Add a PC</button>}
      </div>

      {loadError && <p className="text-xs text-neon-amber">⚠ {loadError} {loadError.includes('404') || /relation|redeploy/i.test(loadError) ? '' : 'If the app was just updated, redeploy the backend.'}</p>}

      {adding && (
        <div className="neon-card rounded-lg border border-white/10 p-4 space-y-3 text-xs">
          <p className="text-slate-300">Add a Windows PC that streams with Sunshine. A small agent on it connects out to GGGH (nothing is opened on your router) so GGGH can see it and control it from here.</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="space-y-1"><span className="label">Name</span><input className="input-neon px-2 py-1 text-xs w-full" value={name} maxLength={40} placeholder="Gaming PC" onChange={(e) => setName(e.target.value)} /></label>
            <label className="space-y-1"><span className="label">MAC address (optional — the PC reports it itself)</span><input className="input-neon px-2 py-1 text-xs w-full" value={mac} placeholder="AA:BB:CC:DD:EE:FF" onChange={(e) => setMac(e.target.value)} /></label>
          </div>
          {formErr && <p className="text-neon-amber">⚠ {formErr}</p>}
          <div className="flex gap-2">
            <button type="button" className="btn-neon text-xs disabled:opacity-40" disabled={!name.trim() || saving} onClick={add}>{saving ? 'Adding…' : 'Add it'}</button>
            <button type="button" className="text-slate-400 hover:text-slate-200 px-2" onClick={() => { setAdding(false); setFormErr(null); }}>Cancel</button>
          </div>
        </div>
      )}

      {created && (
        <div className={`rounded-lg border p-4 space-y-2 text-xs ${connected ? 'border-neon-lime/40' : 'border-neon-cyan/30'}`}>
          {connected
            ? <p className="text-neon-lime">✓ {created.name} is connected. You can use it below.{' '}<button type="button" className="text-slate-400 hover:text-slate-200 underline" onClick={() => setCreated(null)}>Hide this</button></p>
            : <>
              <p className="text-slate-100"><strong>Now connect {created.name}.</strong> On the PC (Windows 11): right-click Start → <strong>Terminal (Admin)</strong>, paste this and press Enter. It installs Sunshine if needed and starts the agent.</p>
              <CopyBox text={created.installCommand} />
              <p className="text-slate-500">Shown only now: it holds a private key for this PC. This panel updates by itself when the PC connects.</p>
              <p className="text-slate-500 animate-pulse">Waiting for the PC to connect…</p>
            </>}
        </div>
      )}

      {list && list.length === 0 && !adding && !created && (
        <p className="text-xs text-slate-500">No local PCs yet. Add one to see it online, wake it, pair Moonlight and get a ready-made terminal command, all from here.</p>
      )}
      <div className="space-y-4">{(list || []).map((m) => <LocalCard key={m.id} m={m} onChanged={load} />)}</div>
    </section>
  );
}
