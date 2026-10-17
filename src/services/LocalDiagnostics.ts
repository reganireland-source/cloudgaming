/**
 * ============================================================================
 * src/services/LocalDiagnostics.ts — WHAT THE AGENT MEASURED, IN PLAIN WORDS
 * ============================================================================
 *
 * The agent on a local PC sends raw facts (a "diagnose" snapshot, a "record" of
 * per-second samples, or logs). This turns them into FINDINGS: what looks wrong,
 * why it matters for streaming, and (where there is a safe, reversible fix) a
 * button for it. It lives here, not on the PC, so the rules can be improved by
 * deploying GGGH, with no agent update, and old reports get the new rules.
 * Also here: the short list of Sunshine settings the app may change.
 * ============================================================================
 */

export interface Fix { label: string; kind: string; args?: Record<string, unknown> }
export interface Finding { id: string; severity: 'bad' | 'warn' | 'info' | 'ok'; title: string; detail: string; fix?: Fix }

/** Sunshine settings the app may change (name → allowed values). Nothing else is ever written. */
export const SUNSHINE_SETTINGS: Record<string, { re: RegExp; hint: string }> = {
  min_log_level: { re: /^(verbose|debug|info|warning|error|fatal|none)$/, hint: 'how much Sunshine writes to its log' },
  capture: { re: /^(ddx|wgc)$/, hint: 'how the screen is captured (ddx or wgc)' },
  encoder: { re: /^(nvenc|quicksync|amdvce|software)$/, hint: 'which encoder makes the video' },
  nvenc_preset: { re: /^[1-7]$/, hint: 'NVIDIA encoder speed/quality, 1 = fastest' },
  nvenc_twopass: { re: /^(disabled|quarter_res|full_res)$/, hint: 'NVIDIA two-pass mode' },
  nvenc_realtime_hags: { re: /^(enabled|disabled)$/, hint: 'prioritise the encoder under heavy GPU load' },
  nvenc_latency_over_power: { re: /^(enabled|disabled)$/, hint: 'favour low latency over power saving' },
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'number' && Number.isFinite(x)) : []);
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface SeriesStats { n: number; min: number; avg: number; p95: number; max: number }
export const stats = (a: number[]): SeriesStats => ({ n: a.length, min: a.length ? Math.min(...a) : 0, avg: r1(avg(a)), p95: r1(pct(a, 95)), max: a.length ? Math.max(...a) : 0 });

/** nvidia-smi's throttle-reason bitmask, e.g. "0x0000000000000004". */
export function throttleReasons(hex: unknown): string[] {
  const v = typeof hex === 'string' && /^0x[0-9a-f]+$/i.test(hex) ? parseInt(hex, 16) : 0;
  const out: string[] = [];
  if (v & 0x4) out.push('power limit');
  if (v & 0x8) out.push('hardware slowdown');
  if (v & 0x10) out.push('hardware thermal slowdown');
  if (v & 0x20) out.push('power brake');
  if (v & 0x40) out.push('software thermal slowdown');
  return out;
}

/** Group repeated log lines ("took 12 ms" and "took 15 ms" are the same problem). */
export function topLogProblems(lines: unknown, limit = 8): Array<{ count: number; level: string; text: string }> {
  const groups = new Map<string, { count: number; level: string; text: string }>();
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw);
    const m = line.match(/\[(warning|error|fatal)\]\s*:?\s*(.*)$/i);
    if (!m) continue;
    const key = (m[1] + m[2]).toLowerCase().replace(/0x[0-9a-f]+/g, '#').replace(/\d+(\.\d+)?/g, '#').slice(0, 160);
    const g = groups.get(key);
    if (g) g.count++; else groups.set(key, { count: 1, level: m[1].toLowerCase(), text: m[2].slice(0, 200) });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

const OVERLAYS: Record<string, string> = {
  nvsphelper64: 'the NVIDIA overlay', nvcontainer: 'NVIDIA GeForce Experience', 'nvidia share': 'NVIDIA ShadowPlay',
  gamebar: 'Xbox Game Bar', gamebarpresencewriter: 'Xbox Game Bar', obs64: 'OBS', discord: 'Discord (its overlay)', rtss: 'RivaTuner / MSI Afterburner overlay',
};

function diagnoseFindings(d: any): Finding[] {
  const f: Finding[] = [];
  const nic = d.nic || {};
  // --- network
  if (nic.name) {
    const mbps = num(nic.linkMbps);
    if (nic.wired === false) f.push({ id: 'nic-wifi', severity: 'bad', title: 'The PC is on Wi-Fi', detail: `${nic.name} is a wireless connection. Streaming from a PC on Wi-Fi is the most common cause of stutter. Use a network cable.` });
    else if (mbps != null && mbps < 900) f.push({ id: 'nic-slow', severity: 'bad', title: `The network cable is only linked at ${mbps} Mbit/s`, detail: 'A gigabit connection should show 1000 Mbit/s. 100 Mbit/s usually means a bad cable, a faulty port or a 100 Mbit switch. A 4K stream at high bitrate cannot fit in that.' });
    else if (mbps != null) f.push({ id: 'nic-ok', severity: 'ok', title: `Network link is ${mbps} Mbit/s${nic.wired ? ', wired' : ''}`, detail: nic.name });
    const s = nic.stats || {};
    const errs = (num(s.rxDiscard) || 0) + (num(s.rxErr) || 0) + (num(s.txDiscard) || 0) + (num(s.txErr) || 0);
    if (errs > 100) f.push({ id: 'nic-errors', severity: 'warn', title: `The network card has dropped or damaged ${errs} packets since boot`, detail: 'A few is normal; thousands point to a bad cable or port, or a driver problem.' });
    const eee = (Array.isArray(nic.adv) ? nic.adv : []).find((p: any) => /energy.?efficient|green ethernet|power saving/i.test(String(p.n)) && /enabled|on|auto/i.test(String(p.v)));
    if (eee) f.push({ id: 'nic-eee', severity: 'info', title: `${eee.n} is on`, detail: 'Energy-saving Ethernet can add small delays when traffic starts and stops. Worth turning off in the adapter’s Advanced settings if you see micro-stutter.' });
  }
  const gw = d.gateway || {};
  if (num(gw.sent)) {
    if ((num(gw.lost) || 0) > 0) f.push({ id: 'gw-loss', severity: 'bad', title: `Lost ${gw.lost} of ${gw.sent} pings to your router`, detail: 'Packet loss between the PC and the router (even on a cable) breaks streaming. Check the cable and the switch/router port.' });
    else if ((num(gw.maxMs) || 0) > 10) f.push({ id: 'gw-jitter', severity: 'warn', title: `Pings to the router spiked to ${gw.maxMs} ms`, detail: 'On a wired network this should stay under 2–3 ms. Something is interfering: a busy switch, a bad cable or a power-saving setting.' });
    else f.push({ id: 'gw-ok', severity: 'ok', title: `Router ping is fine (${gw.avgMs} ms average)`, detail: '' });
  }
  // --- power and GPU
  const power = String(d.power?.active || d.power?.guid || '');
  const goodPlan = ['8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c', 'e9a42b02-d5df-448d-aa00-03f14749eb61'].includes(String(d.power?.guid || '')) || /high performance|ultimate/i.test(String(d.power?.active || ''));
  if (power && !goodPlan) f.push({ id: 'power-plan', severity: 'warn', title: `Windows power plan is "${power}"`, detail: 'Balanced and power-saver plans let the CPU and GPU slow down between frames, which shows up as stutter and added delay when streaming.', fix: { label: 'Switch to High performance', kind: 'power-plan', args: { plan: 'high' } } });
  const g = d.gpu || {};
  if (g.name) {
    const sm = num(g.smClock), smMax = num(g.smClockMax);
    if (sm != null && smMax && sm < smMax * 0.5 && (num(g.util) || 0) < 30) f.push({ id: 'gpu-idle-clocks', severity: 'info', title: `The GPU is idling at ${sm} MHz (max ${smMax})`, detail: 'Normal when nothing is running. If streams stutter at the start or in light scenes, the GPU may be slow to ramp up: the Record test will show it, and locking the clocks is the fix.' });
    const th = throttleReasons(g.throttle);
    if (th.length) f.push({ id: 'gpu-throttle', severity: 'warn', title: `The GPU is being held back (${th.join(', ')})`, detail: 'It is not running as fast as it can. Check its temperature and cooling, and the power cable.' });
    if ((num(g.tempC) || 0) >= 85) f.push({ id: 'gpu-hot', severity: 'warn', title: `The GPU is at ${g.tempC}°C`, detail: 'Very hot; it will slow itself down.' });
    const gen = num(g.pcieGen), w = num(g.pcieWidth);
    if (w != null && w < 8 && (num(g.util) || 0) > 50) f.push({ id: 'pcie', severity: 'warn', title: `The GPU is running on only ${w} PCIe lanes`, detail: 'It should normally be x16. Re-seat the card or check the slot.' });
    else if (gen != null && w != null) f.push({ id: 'pcie-ok', severity: 'ok', title: `GPU: ${g.name}, driver ${g.driver}, PCIe ${gen} x${w}`, detail: '' });
  }
  if (d.hags === 2) f.push({ id: 'hags', severity: 'info', title: 'Hardware-accelerated GPU scheduling is on', detail: 'Usually good. If you have stutter that only happens under heavy game load, turning it off in Windows (Settings → Display → Graphics) and restarting is a known thing to try.' });
  // --- display
  const disp = Array.isArray(d.displays) ? d.displays : [];
  if (disp.length && disp.every((x: any) => (num(x.hz) || 0) > 0 && (num(x.hz) || 0) < 60)) f.push({ id: 'refresh', severity: 'warn', title: `The PC’s screen is at ${disp[0].hz} Hz`, detail: 'Below 60 Hz, a 60 fps stream cannot be smooth.' });
  if (num(d.monitors) === 0) f.push({ id: 'no-monitor', severity: 'warn', title: 'No monitor is attached', detail: 'With no screen (or one turned off), capture can fail or fall back to a slow mode. A cheap HDMI dummy plug or a virtual display fixes this.' });
  // --- CPU, memory, programs
  const ram = d.ram || {};
  if (num(ram.freeGb) != null && num(ram.totalGb) && ram.freeGb < 2) f.push({ id: 'ram', severity: 'warn', title: `Only ${ram.freeGb} GB of memory is free`, detail: 'Low memory makes Windows swap to disk, which stalls everything, streaming included.' });
  // Per-process CPU is "percent of one core"; compare with the whole CPU.
  const threads = num(d.cpu?.threads) || 1;
  const hogs = (Array.isArray(d.procs) ? d.procs : []).filter((p: any) => (num(p.cpu) || 0) / threads >= 25 && !/^(sunshine|system|idle)/i.test(String(p.name)));
  if (hogs.length) f.push({ id: 'cpu-hog', severity: 'warn', title: `${hogs.map((p: any) => `${p.name} (${Math.round((num(p.cpu) || 0) / threads)}% of the CPU)`).join(', ')} using a lot of CPU`, detail: 'Something other than Sunshine is busy right now. If that is the game, that is expected; if not, close it while streaming.' });
  const ov = (Array.isArray(d.overlays) ? d.overlays : []).map((n: string) => OVERLAYS[String(n).toLowerCase()]).filter(Boolean);
  if (ov.length) f.push({ id: 'overlays', severity: 'info', title: `Running: ${[...new Set(ov)].join(', ')}`, detail: 'Capture and overlay tools compete with Sunshine for the screen and encoder. Close them while testing.' });
  // --- Sunshine
  const s = d.sunshine || {};
  if (s.service && s.service !== 'Running') f.push({ id: 'sunshine-down', severity: 'bad', title: `Sunshine is ${s.service}`, detail: 'The streaming service is not running.', fix: { label: 'Restart Sunshine', kind: 'sunshine-restart' } });
  const probs = topLogProblems(s.logTail);
  for (const p of probs.slice(0, 5)) f.push({ id: 'log-' + p.text.slice(0, 20), severity: p.level === 'warning' ? 'warn' : 'bad', title: `Sunshine log (${p.count}×): ${p.text}`, detail: 'Repeated warnings and errors in Sunshine’s own log.' });
  // --- Windows event log
  for (const e of (Array.isArray(d.events) ? d.events : []).filter((x: any) => /display|nvlddmkm|whea|hang/i.test(String(x.provider))).slice(0, 3)) {
    f.push({ id: 'event-' + e.provider + e.id, severity: 'warn', title: `Windows reported ${e.count}× ${e.provider} (event ${e.id}) in the last day`, detail: String(e.sample || '').slice(0, 200) });
  }
  return f;
}

function recordFindings(d: any): Finding[] {
  const f: Finding[] = [];
  const S = d.series || {};
  const enc = arr(S.encUtil), gpu = arr(S.gpuUtil), sm = arr(S.smClock), cpu = arr(S.cpu), ping = arr(S.pingMs), tx = arr(S.txMbps), pst = arr(S.streaming);
  const secs = num(d.seconds) || gpu.length;
  const streamingFrac = pst.length ? avg(pst) : null;
  if (streamingFrac != null && streamingFrac < 0.3) {
    f.push({ id: 'rec-nostream', severity: 'bad', title: 'Nobody was streaming during this recording', detail: 'The encoder was idle for most of it, so the numbers say little about streaming. Start a stream (or the game) first, then press Record.' });
  }
  if (!gpu.length) return f;
  const g = stats(gpu), e = stats(enc), c = stats(cpu), p = stats(ping), t = stats(tx);
  if (enc.length && e.avg > 80) f.push({ id: 'rec-enc', severity: 'warn', title: `The video encoder was ${e.avg}% busy`, detail: 'The encoder itself is the limit. Lower the resolution, frame rate or bitrate in the Moonlight command, or try a faster NVIDIA preset (1 is fastest).', fix: { label: 'Set NVIDIA preset to 1 (fastest)', kind: 'sunshine-config', args: { key: 'nvenc_preset', value: '1' } } });
  if (g.avg > 95) f.push({ id: 'rec-gpu', severity: 'warn', title: `The GPU was ${g.avg}% busy`, detail: 'The game is using all of the GPU, leaving little for the stream. Cap the game’s frame rate (a little under your stream’s) or lower its settings; a pinned GPU adds delay to everything.' });
  const maxClock = num(d.smClockMax);
  if (sm.length && maxClock && stats(sm).avg < maxClock * 0.6 && g.avg > 30) f.push({ id: 'rec-clocks', severity: 'warn', title: `The GPU ran at ${stats(sm).avg} MHz while busy (it can do ${maxClock})`, detail: 'It is not boosting to full speed. Locking the clocks stops it ramping up and down.', fix: { label: 'Lock GPU clocks (until reboot)', kind: 'gpu-clocks', args: { action: 'lock' } } });
  const th = [...new Set((Array.isArray(d.throttle) ? d.throttle : []).flatMap((h: string) => throttleReasons(h)))];
  if (th.length) f.push({ id: 'rec-throttle', severity: 'warn', title: `The GPU was held back by: ${th.join(', ')}`, detail: 'Cooling or power limits. Check temperatures and fans.' });
  if (cpu.length && c.avg > 80) f.push({ id: 'rec-cpu', severity: 'warn', title: `The CPU averaged ${c.avg}%`, detail: 'A busy CPU delays the stream’s capture and network work.' });
  if (ping.length) {
    const lost = (num(d.pingLost) || 0);
    if (lost > 0 || p.p95 > 5) f.push({ id: 'rec-ping', severity: 'bad', title: lost ? `${lost} of ${ping.length + lost} pings to the router were lost` : `Router ping spiked (95% under ${p.p95} ms, worst ${p.max} ms)`, detail: 'On a wired network this should be steady under 2–3 ms. Spikes or loss while streaming mean the cable, port or switch is struggling, or something else is flooding the network.' });
    else f.push({ id: 'rec-ping-ok', severity: 'ok', title: `Router ping was steady (${p.avg} ms average, worst ${p.max} ms)`, detail: '' });
  }
  if (tx.length && streamingFrac != null && streamingFrac >= 0.3) f.push({ id: 'rec-tx', severity: 'info', title: `The PC sent ${t.avg} Mbit/s on average (peak ${t.max})`, detail: 'This is what the stream actually used. If it is far below the bitrate you asked for, the PC is not producing frames fast enough.' });
  if (!f.some((x) => x.severity !== 'ok' && x.severity !== 'info')) f.push({ id: 'rec-clean', severity: 'ok', title: `Nothing on the PC side stood out over ${secs} s`, detail: 'If it still feels bad, look at the Moonlight performance overlay on the Mac (decode time, dropped frames, network delay) and the Mac’s own network.' });
  return f;
}

export function evaluateReport(kind: string, data: any): Finding[] {
  try {
    if (kind === 'diagnose') return diagnoseFindings(data || {});
    if (kind === 'record') return recordFindings(data || {});
  } catch (e) { return [{ id: 'eval-failed', severity: 'warn', title: 'Could not analyse this report', detail: (e as Error).message }]; }
  return [];
}

/** The same findings as plain text, for pasting to Claude (no tokens, no logins). */
export function reportText(name: string, kind: string, createdAt: string, data: any, findings: Finding[]): string {
  const out = [`GGGH local machine report: ${name} (${kind}, ${createdAt})`, '', 'FINDINGS'];
  for (const x of findings) out.push(`- [${x.severity}] ${x.title}${x.detail ? ': ' + x.detail : ''}`);
  const d = data || {};
  if (kind === 'diagnose') {
    out.push('', 'FACTS', JSON.stringify({ os: d.os, cpu: d.cpu, ram: d.ram, power: d.power, hags: d.hags, nic: d.nic, gateway: d.gateway, gpu: d.gpu, displays: d.displays, monitors: d.monitors, sunshine: { version: d.sunshine?.version, service: d.sunshine?.service, account: d.sunshine?.account, config: d.sunshine?.config }, procs: d.procs, overlays: d.overlays, events: d.events }));
    if (Array.isArray(d.sunshine?.logTail)) out.push('', 'SUNSHINE LOG (tail)', ...d.sunshine.logTail.slice(-120).map(String));
  } else if (kind === 'record') {
    const S = d.series || {};
    out.push('', 'STATS (min / avg / p95 / max)');
    for (const k of Object.keys(S)) { const s = stats(arr(S[k])); out.push(`${k}: ${s.min} / ${s.avg} / ${s.p95} / ${s.max} (n=${s.n})`); }
  }
  return out.join('\n');
}
