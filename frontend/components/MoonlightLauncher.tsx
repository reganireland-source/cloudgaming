'use client';

/**
 * ============================================================================
 * frontend/components/MoonlightLauncher.tsx — "PAIR" AND "LAUNCH MOONLIGHT"
 * ============================================================================
 *
 * Moonlight is the app you play on. A website can't start programs on your
 * computer directly (browsers forbid it for safety), so this gives you the
 * exact Moonlight COMMAND to run — copy it into a terminal, or download a
 * small launcher file you double-click. Both use settings that match the
 * machine's server-side configuration.
 *
 * 1) PAIR (once per device): press the button → the backend picks a PIN and
 *    shows `moonlight pair <ip> --pin 1234`. Run it; the backend enters the
 *    same PIN into Sunshine for you (MachineService.pair). Live log below.
 *
 * 2) LAUNCH: `moonlight stream <ip> "<app>" --resolution … --fps …
 *    --bitrate … --video-codec …` with values from the machine's streaming
 *    quality preset:
 *       budget  1280x720  @30  3 Mbps  H.264
 *       good    1920x1080 @60  8 Mbps  HEVC
 *       high    2560x1440 @60 12 Mbps  HEVC
 *       ultra   2560x1440 @60 20 Mbps  HEVC
 *    "ultra" is capped at 2560x1440 because the machines use datacenter GPUs
 *    (T4/L4/A10G/A10), whose virtual screen is limited to 2560x1600 — the
 *    streaming container is configured with that same cap.
 *    "Your screen" reshapes the stream to your display (MacBook 16:10 or
 *    full-notch, ultrawide 21:9/32:9, tablets): same pixel budget as the
 *    preset, the display's aspect ratio, within 2560x1600 (lib/screens.ts).
 *    The machine builds a matching virtual screen for any size requested.
 *    The app names ("Desktop", "Steam (Big Picture)"…) are the ones defined
 *    in the Sunshine container on the machine.
 *
 * Moonlight's command line (moonlight-qt) runs on Windows, macOS and Linux.
 * On phones/TVs/consoles, open the Moonlight app and pick the machine instead.
 * ============================================================================
 */

import { useEffect, useMemo, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/auth';
import OperationConsole from './OperationConsole';
import FriendlyErrorCard from './FriendlyErrorCard';
import { SCREENS, fitResolution, detectScreen, MAX_W, MAX_H } from '@/lib/screens';

type OS = 'windows' | 'macos' | 'linux';

/** Stream settings per quality preset (see header). */
const PRESETS: Record<string, { resolution: string; fps: number; bitrateKbps: number; codec: 'H.264' | 'HEVC'; label: string }> = {
  budget: { resolution: '1280x720', fps: 30, bitrateKbps: 3000, codec: 'H.264', label: 'Budget · 720p30 · 3 Mbps' },
  good: { resolution: '1920x1080', fps: 60, bitrateKbps: 8000, codec: 'HEVC', label: 'Good · 1080p60 · 8 Mbps' },
  high: { resolution: '2560x1440', fps: 60, bitrateKbps: 12000, codec: 'HEVC', label: 'High · 1440p60 · 12 Mbps' },
  ultra: { resolution: '2560x1440', fps: 60, bitrateKbps: 20000, codec: 'HEVC', label: 'Ultra · 1440p60 · 20 Mbps (max for datacenter GPUs)' },
};

/** Apps defined in the Sunshine container on the machine. */
const APPS = ['Desktop', 'Steam (Big Picture)', 'Steam', 'Battle.net', 'Discord', 'Google Chrome', 'Heroic Games Launcher', 'Lutris', 'Firefox'];

/** Where Moonlight's program lives on each OS (default install locations). */
const MOONLIGHT_EXE: Record<OS, string> = {
  windows: '"%ProgramFiles%\\Moonlight Game Streaming\\Moonlight.exe"',
  macos: '/Applications/Moonlight.app/Contents/MacOS/Moonlight',
  linux: 'moonlight',
};

function detectOS(): OS {
  if (typeof navigator === 'undefined') return 'windows';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('linux') && !ua.includes('android')) return 'linux';
  return 'windows';
}

function isMobile(): boolean {
  return typeof navigator !== 'undefined' && /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

/** Put a value in quotes suitable for this OS's shell. */
function quote(value: string, os: OS): string {
  return os === 'windows' ? `"${value}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}

function CopyBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="whitespace-pre-wrap break-all text-[0.72rem] font-mono text-neon-lime bg-black/40 border border-white/10 rounded p-3 pr-16">{text}</pre>
      <button
        type="button"
        onClick={async () => {
          try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* select manually */ }
        }}
        className="absolute top-2 right-2 text-[0.66rem] uppercase tracking-label text-neon-cyan/80 hover:text-neon-cyan border border-neon-cyan/30 rounded px-2 py-0.5"
      >
        {copied ? 'copied ✓' : 'copy'}
      </button>
    </div>
  );
}

/** Offer text as a file download (done entirely in the browser). */
function download(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function MoonlightLauncher({
  machineId, host, quality, ready,
}: {
  machineId: string;
  host: string;
  quality: string;        // the machine's streaming preset
  ready: boolean;         // on-machine setup finished?
}) {
  const [os, setOs] = useState<OS>('windows');
  const [app, setApp] = useState('Desktop');
  const [preset, setPreset] = useState(PRESETS[quality] ? quality : 'high');
  const [fullscreen, setFullscreen] = useState(true);
  // Screen shape: 'auto' = this device's display; else a SCREENS preset id.
  const [screenId, setScreenId] = useState('16x9');
  const [detected, setDetected] = useState<{ w: number; h: number } | null>(null);
  const [pairing, setPairing] = useState<{ operationId: string; pin: string; host: string } | null>(null);
  const [pairError, setPairError] = useState<ApiError | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const mobile = typeof window !== 'undefined' && isMobile();

  useEffect(() => setOs(detectOS()), []);
  useEffect(() => {
    // Default to this device's shape when it isn't plain 16:9 (e.g. a MacBook).
    const d = detectScreen();
    setDetected(d);
    try { const saved = localStorage.getItem('moonlight.screen'); if (saved) { setScreenId(saved); return; } } catch { /* no storage */ }
    if (d && Math.abs(d.w / d.h - 16 / 9) > 0.02) setScreenId('auto');
  }, []);
  const pickScreen = (id: string) => { setScreenId(id); try { localStorage.setItem('moonlight.screen', id); } catch { /* no storage */ } };
  useEffect(() => { if (PRESETS[quality]) setPreset(quality); }, [quality]);

  const base = PRESETS[preset];
  const exe = MOONLIGHT_EXE[os];
  // The stream's size: the preset's pixel budget in the chosen screen's shape.
  const screen = screenId === 'auto' ? detected : SCREENS.find((x) => x.id === screenId) || null;
  const [bw, bh] = base.resolution.split('x').map(Number);
  const fitted = screen && screenId !== '16x9' ? fitResolution(screen, bw * bh) : { w: bw, h: bh };
  // Bitrate follows the pixel count (within ±40% of the preset's).
  const scale = Math.min(1.4, Math.max(0.6, (fitted.w * fitted.h) / (bw * bh)));
  const p = { ...base, resolution: `${fitted.w}x${fitted.h}`, bitrateKbps: Math.round((base.bitrateKbps * scale) / 500) * 500 };
  const capped = !!screen && (screen.w > MAX_W || screen.h > MAX_H) && fitted.w * fitted.h < screen.w * screen.h && (fitted.w === MAX_W || fitted.h === MAX_H);

  const streamCommand = useMemo(() => [
    exe, 'stream', host, quote(app, os),
    '--resolution', p.resolution,
    '--fps', String(p.fps),
    '--bitrate', String(p.bitrateKbps),
    '--video-codec', p.codec,
    '--display-mode', fullscreen ? 'fullscreen' : 'windowed',
    '--audio-config', 'stereo',
    '--game-optimization',
    '--quit-after',
  ].join(' '), [exe, host, app, os, p, fullscreen]);

  const pairCommand = pairing ? `${exe} pair ${pairing.host} --pin ${pairing.pin}` : '';

  const launcherFile = () => {
    const safeName = app.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (os === 'windows') {
      download(`moonlight-${safeName}.bat`, `@echo off\r\nREM Gints Global Gaming Hubjob: stream "${app}" from ${host}\r\n${streamCommand.replace(/'/g, '"')}\r\n`);
    } else {
      // macOS: .command files open in Terminal on double-click (you may need to
      // allow it once: right-click → Open). Linux: run with "sh file.sh".
      download(`moonlight-${safeName}.${os === 'macos' ? 'command' : 'sh'}`, `#!/bin/sh\n# Gints Global Gaming Hubjob: stream "${app}" from ${host}\n${streamCommand}\n`);
    }
  };

  const startPairing = async () => {
    setPairBusy(true);
    setPairError(null);
    try {
      setPairing(await apiFetch<{ operationId: string; pin: string; host: string }>(`/machines/${machineId}/pair`, { method: 'POST' }));
    } catch (e) {
      setPairError(e as ApiError);
    } finally {
      setPairBusy(false);
    }
  };

  return (
    <div className="space-y-5 text-sm">
      {!ready && (
        <p className="text-xs text-neon-amber">⚠ The machine is still setting up — pairing and streaming work once Setup progress says “Ready to stream”.</p>
      )}
      {mobile && (
        <p className="text-xs text-slate-400">On a phone or tablet: open the Moonlight app, tap + and add <span className="font-mono">{host}</span>. The commands below are for Windows, macOS and Linux.</p>
      )}

      {/* OS picker */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="label mr-1">Your computer</span>
        {(['windows', 'macos', 'linux'] as OS[]).map((o) => (
          <button key={o} type="button" onClick={() => setOs(o)}
            className={`text-xs rounded border px-2.5 py-1 ${os === o ? 'border-neon-cyan text-neon-cyan bg-neon-cyan/[0.06]' : 'border-white/10 text-slate-400 hover:border-white/30'}`}>
            {{ windows: 'Windows', macos: 'macOS', linux: 'Linux' }[o]}
          </button>
        ))}
        <a href="https://moonlight-stream.org" target="_blank" rel="noopener noreferrer" className="text-xs text-neon-cyan hover:underline ml-auto">Get Moonlight ↗</a>
      </div>

      {/* 1. Pair */}
      <div className="space-y-2">
        <p className="label">1 · Pair this device (once)</p>
        {!pairing ? (
          // Disabled until setup reaches "Ready to stream": Sunshine isn't
          // running before that, and pairing gives up after 3 minutes.
          <button type="button" onClick={startPairing} disabled={pairBusy || !ready} className="btn-neon text-xs disabled:opacity-50 disabled:cursor-not-allowed">
            {pairBusy ? 'Preparing…' : ready ? 'Pair Moonlight (one click)' : 'Pair Moonlight (available when setup is ready)'}
          </button>
        ) : (
          <>
            <p className="text-xs text-slate-300">Run this now — the app enters PIN <strong className="text-neon-lime font-mono">{pairing.pin}</strong> into Sunshine for you:</p>
            <CopyBox text={pairCommand} />
            <OperationConsole operationId={pairing.operationId} height="max-h-40" />
            <button type="button" onClick={() => setPairing(null)} className="text-xs text-slate-400 hover:text-slate-200">New PIN</button>
          </>
        )}
        {pairError && <FriendlyErrorCard message={pairError.message} tip={pairError.tip} friendly={pairError.friendly} />}
      </div>

      {/* 2. Launch */}
      <div className="space-y-3">
        <p className="label">2 · Launch Moonlight</p>
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="text-xs text-slate-400 space-y-1">
            <span className="block">What to open</span>
            <select value={app} onChange={(e) => setApp(e.target.value)} className="input-neon w-full px-2 py-1.5">
              {APPS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            <span className="block">Quality {preset === quality && '(machine default)'}</span>
            <select value={preset} onChange={(e) => setPreset(e.target.value)} className="input-neon w-full px-2 py-1.5">
              {Object.entries(PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            <span className="block">Your screen</span>
            <select value={screenId} onChange={(e) => pickScreen(e.target.value)} className="input-neon w-full px-2 py-1.5">
              <option value="auto" disabled={!detected}>This screen{detected ? ` (${detected.w}×${detected.h})` : ''}</option>
              {Array.from(new Set(SCREENS.map((x) => x.group))).map((g) => (
                <optgroup key={g} label={g}>
                  {SCREENS.filter((x) => x.group === g).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
          <span>Stream: <span className="font-mono text-slate-200">{fitted.w}×{fitted.h}</span> @ {p.fps} fps · {(p.bitrateKbps / 1000).toFixed(1)} Mbps</span>
          <span className="text-slate-500">In the Moonlight app instead: Settings → Resolution → Custom → {fitted.w}×{fitted.h}</span>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={fullscreen} onChange={(e) => setFullscreen(e.target.checked)} /> Full screen
          </label>
        </div>
        {screen && screenId !== '16x9' && (
          <p className="text-[0.7rem] text-slate-500 leading-relaxed">
            The machine makes its screen exactly this shape, so games and the desktop fill your display with no black bars.
            {capped && <> Your screen is bigger than the {MAX_W}×{MAX_H} a datacenter GPU can drive, so the stream keeps its shape at up to that size and Moonlight scales it up to fill the display.</>}
            {/* Notched MacBooks are ~1.54:1 across the whole panel (16:10 below the notch). */}
            {Math.abs(screen.w / screen.h - 1.543) < 0.008 && <> Using the whole screen puts the top strip behind the notch; pick “below the notch” if the menu bar of games gets hidden.</>}
          </p>
        )}
        <CopyBox text={streamCommand} />
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={launcherFile} className="btn-neon-magenta text-xs">
            ⬇ Download launcher ({os === 'windows' ? '.bat' : os === 'macos' ? '.command' : '.sh'})
          </button>
        </div>
        <p className="text-[0.7rem] text-slate-500 leading-relaxed">
          {os === 'windows' && 'Double-click the .bat file, or paste the command into Command Prompt. '}
          {os === 'macos' && 'Paste the command into Terminal, or double-click the .command file (first time: right-click → Open, or run "chmod +x" on it). '}
          {os === 'linux' && 'Paste the command into a terminal, or run: sh <file>.sh. Using the Flatpak? Replace "moonlight" with "flatpak run com.moonlight_stream.Moonlight". '}
          Settings match the machine&apos;s {PRESETS[quality] ? `"${quality}"` : ''} preset; the stream uses about {Math.round((p.bitrateKbps * 3600) / 8 / 1000 / 100) / 10} GB per hour, billed by the cloud as data out.
        </p>
      </div>
    </div>
  );
}
