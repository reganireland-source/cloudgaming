/**
 * ============================================================================
 * src/services/TelemetryService.ts — REAL MACHINE TELEMETRY
 * ============================================================================
 *
 * Each machine's on-machine agent (src/providers/shared/agent.ts) prints a
 * "CGT {json}" sample to its serial console every 15 s: CPU, RAM, disk and
 * disk I/O, network, GPU (load, VRAM, temperature, power, clocks, video
 * encoder sessions/fps/latency), NVIDIA Xid errors, out-of-memory kills,
 * failed services, containers and the busiest processes. The serial console
 * is read through the cloud's API — no ports are opened on the machine.
 *
 *   ingest()   read one machine's console, store new samples (deduped by
 *              timestamp) in machine_telemetry
 *   live()     the Monitor view: ingest if the last read is > 12 s old (one
 *              read at a time per machine), then samples for the window +
 *              the latest one + alerts
 *   collectTelemetryJob()  every minute for running machines (Oracle every
 *              5 min: its console capture is slow); keeps 7 days
 * ============================================================================
 */

import { query } from '../config/database';
import { providerFor } from './CredentialService';
import type { TelemetrySample } from '../providers/shared/setupScript';
import { CATALOGS } from '../providers/registry';

export interface TelemetryAlert { level: 'critical' | 'warning' | 'info'; key: string; text: string }

const lastRead = new Map<string, number>();
const inFlight = new Map<string, Promise<number>>();

/** Read the machine's console and store any samples we don't have yet. Returns how many were new. */
export async function ingest(userId: string, machine: { id: string; provider: string; instance_id: string }): Promise<number> {
  const running = inFlight.get(machine.id);
  if (running) return running;
  const p = (async () => {
    try {
      const provider = await providerFor(userId, machine.provider);
      const samples = await provider.getTelemetry(machine.instance_id);
      lastRead.set(machine.id, Date.now());
      if (!samples.length) return 0;
      // One multi-row insert; ON CONFLICT skips samples already stored.
      const recent = samples.slice(-240); // at most the last hour
      const values = recent.map((_, i) => `($1, to_timestamp($${i * 2 + 2}), $${i * 2 + 3})`).join(',');
      const params: unknown[] = [machine.id];
      for (const s of recent) params.push(s.t, JSON.stringify(s));
      const r = await query(`INSERT INTO machine_telemetry (machine_id, t, data) VALUES ${values} ON CONFLICT DO NOTHING`, params);
      return r.rowCount || 0;
    } finally {
      inFlight.delete(machine.id);
    }
  })();
  inFlight.set(machine.id, p);
  return p;
}

/** Problems worth flagging in a sample (icon + words in the UI, never colour alone). */
export function alertsFor(s: TelemetrySample | null, prev?: TelemetrySample | null): TelemetryAlert[] {
  if (!s) return [];
  const a: TelemetryAlert[] = [];
  const g = s.g || null;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const tp = num(g?.tp), vu = num(g?.vu), vt = num(g?.vt), pw = num(g?.pw), pl = num(g?.pl);
  if (tp != null && tp >= 87) a.push({ level: 'critical', key: 'gpu-temp', text: `GPU at ${tp} °C — it will slow itself down to cool off` });
  else if (tp != null && tp >= 80) a.push({ level: 'warning', key: 'gpu-temp', text: `GPU running hot: ${tp} °C` });
  if (vu != null && vt && vu / vt >= 0.95) a.push({ level: 'warning', key: 'vram', text: `Video memory almost full (${Math.round(vu / 1024)} of ${Math.round(vt / 1024)} GB) — lower texture quality if games stutter` });
  if (pw != null && pl && pw / pl >= 0.98) a.push({ level: 'info', key: 'power', text: `GPU at its power limit (${Math.round(pw)} of ${Math.round(pl)} W)` });
  const th = String(g?.th || '');
  // Throttle reasons are a hex bit mask; 0x1 = idle, 0x4 = app clocks: not a problem.
  const mask = /^0x[0-9a-f]+$/i.test(th) ? parseInt(th, 16) & ~0x5 : 0;
  if (mask & 0x68) a.push({ level: 'warning', key: 'throttle', text: 'GPU is throttling (heat or power) — frame rates may dip' });
  if (s.m && s.m[1] && s.m[0] / s.m[1] >= 0.92) a.push({ level: 'warning', key: 'ram', text: `RAM almost full (${s.m[0]} of ${s.m[1]} GB)` });
  if (s.d && s.d[1] && s.d[0] / s.d[1] >= 0.9) a.push({ level: s.d[0] / s.d[1] >= 0.97 ? 'critical' : 'warning', key: 'disk', text: `Disk ${Math.round((s.d[0] / s.d[1]) * 100)}% full — enlarge it on the Machines page` });
  if (s.gf?.f != null && s.gf.f < 30) a.push({ level: 'warning', key: 'fps', text: `${s.gf.n} is running at ${Math.round(s.gf.f)} fps — lower its graphics settings, or try a bigger tier` });
  else if (s.gf?.lo != null && s.gf.f != null && s.gf.lo < s.gf.f * 0.5) a.push({ level: 'info', key: 'stutter', text: `${s.gf.n} stutters: dips to ${Math.round(s.gf.lo)} fps (worst frame ${Math.round(s.gf.ft ?? 0)} ms)` });
  // Why the frame rate is what it is: only when a game is running.
  const top = s.cc?.[0] ?? null, gpuU = num(g?.u);
  if (s.gf?.f != null && gpuU != null) {
    if (gpuU >= 95) a.push({ level: 'info', key: 'bottleneck', text: `${s.gf.n} is GPU-bound (GPU at ${Math.round(gpuU)}%): lower its graphics settings, or use a bigger GPU tier` });
    else if (top != null && top >= 90) a.push({ level: 'info', key: 'bottleneck', text: `${s.gf.n} is CPU-bound: one core is at ${Math.round(top)}% (the CPU is only ${Math.round(s.c ?? 0)}% overall) — more cores won't help, a faster core would` });
    else if (gpuU < 70 && (top == null || top < 70)) a.push({ level: 'info', key: 'bottleneck', text: `${s.gf.n} is limited by the game itself (frame cap or v-sync): neither the GPU (${Math.round(gpuU)}%) nor the CPU is the limit` });
  } else if (top != null && top >= 95 && (s.c ?? 100) < 60 && num(g?.es)) {
    a.push({ level: 'info', key: 'core', text: `One CPU core is maxed out (${Math.round(top)}%) while the whole CPU is at ${Math.round(s.c ?? 0)}%: a single-threaded program is the limit` });
  }
  if (s.sp) a.push({ level: 'critical', key: 'spot', text: `The cloud is taking back this spot machine (${s.sp}). It stops within a minute or two: save your work now` });
  if (s.ne && (s.ne[0] + s.ne[1] >= 10 || s.ne[2] >= 5)) a.push({ level: 'warning', key: 'neterr', text: `Network trouble on the machine: ${s.ne[0]} errors, ${s.ne[1]} dropped packets and ${s.ne[2]} UDP errors in the last 15 s — it can show up as stream stutter` });
  if (s.rt && !s.rt.o) {
    if ((s.rt.l ?? 0) >= 2) a.push({ level: 'warning', key: 'loss', text: `${s.rt.l}% packet loss to your device — expect stream glitches; try a wired connection or a lower bitrate` });
    if ((s.rt.r ?? 0) >= 80) a.push({ level: 'warning', key: 'latency', text: `Ping to your device is ${Math.round(s.rt.r!)} ms — pick a region nearer to you` });
    else if ((s.rt.j ?? 0) >= 15) a.push({ level: 'info', key: 'jitter', text: `Uneven connection to your device (jitter ${Math.round(s.rt.j!)} ms)` });
  }
  const pr = s.pr || [];
  if ((pr[0] ?? 0) >= 25) a.push({ level: 'warning', key: 'psi-cpu', text: `Programs spend ${Math.round(pr[0]!)}% of the time waiting for CPU time` });
  if ((pr[1] ?? 0) >= 10) a.push({ level: 'warning', key: 'psi-mem', text: `The machine is short of memory: programs wait ${Math.round(pr[1]!)}% of the time for it` });
  if ((pr[2] ?? 0) >= 25) a.push({ level: 'warning', key: 'psi-io', text: `The disk is the bottleneck: programs wait ${Math.round(pr[2]!)}% of the time for it` });
  if ((s.cs ?? 0) >= 10) a.push({ level: 'warning', key: 'steal', text: `Other customers sharing this host are taking about ${Math.round(s.cs!)}% of your CPU (steal) — a different machine type or region may help` });
  const dl = s.dl || [];
  if ((dl[0] ?? 0) >= 50 || (dl[1] ?? 0) >= 50) a.push({ level: 'warning', key: 'disklat', text: `The disk is slow: ${Math.round(Math.max(dl[0] ?? 0, dl[1] ?? 0))} ms per operation` });
  const lw = num(g?.lw), lm = num(g?.lm), lg = num(g?.lg), lx = num(g?.lx);
  if (gpuU != null && gpuU >= 30 && ((lw != null && lm != null && lw < lm) || (lg != null && lx != null && lg < lx))) {
    a.push({ level: 'info', key: 'pcie', text: `GPU link is running reduced under load (x${lw} of x${lm}, gen ${lg} of ${lx})` });
  }
  if ((s.cm ?? 0) >= 97) a.push({ level: 'info', key: 'cpu', text: `CPU maxed out (peak ${s.cm}%) — a bigger machine may help CPU-heavy games` });
  if ((s.x ?? 0) > 0) a.push({ level: 'critical', key: 'xid', text: `${s.x} NVIDIA GPU error${s.x === 1 ? '' : 's'} (Xid) since boot${s.xl ? `: ${s.xl.replace(/^NVRM: /, '')}` : ''}` });
  if ((s.o ?? 0) > 0) a.push({ level: 'critical', key: 'oom', text: `${s.o} program${s.o === 1 ? ' was' : 's were'} killed for lack of memory since boot` });
  if (s.f?.length) a.push({ level: 'warning', key: 'failed', text: `Failed service${s.f.length === 1 ? '' : 's'}: ${s.f.join(', ')}` });
  const down = (s.k || []).filter((k) => !/:\s*Up\b/.test(k));
  if (down.length) a.push({ level: 'warning', key: 'containers', text: `Not running: ${down.join(' · ')}` });
  // Health checks fail while the container is still starting: ignore the first 10 min after boot.
  if ((s.up ?? 0) > 600 && s.k?.some((k) => /unhealthy/i.test(k))) {
    const why = s.sn?.e?.length ? ` — Sunshine says: ${s.sn.e[s.sn.e.length - 1]}`
      : s.sn?.l?.length ? ` — Sunshine's last log line: ${s.sn.l[s.sn.l.length - 1]}` : '';
    const loop = (s.sn?.x ?? 0) > 1 ? ` (Sunshine has restarted ${s.sn!.x} times)` : '';
    a.push({ level: 'warning', key: 'unhealthy', text: `The streaming container reports itself unhealthy: Sunshine isn’t answering${loop}${why}` });
  }
  if (prev && s.up != null && prev.up != null && s.up < prev.up) a.push({ level: 'info', key: 'reboot', text: 'The machine restarted recently' });
  return a;
}

/**
 * Since the last boot: how long the machine has run, how long it actually streamed, how long it has been idle
 * (and so when auto-stop will act), plus the egress price and a disk-full forecast. All from stored samples.
 */
async function usageFor(machine: any, latest: TelemetrySample) {
  const up = Math.max(0, Math.round(latest.up ?? 0));
  const out: Record<string, unknown> = {};
  try {
    const rows = (await query(
      `SELECT EXTRACT(EPOCH FROM t)::bigint AS t, COALESCE((data->'g'->>'es')::float, 0) AS es FROM machine_telemetry
        WHERE machine_id = $1 AND t > NOW() - ($2 || ' seconds')::interval ORDER BY t`,
      [machine.id, String(Math.min(up || 3600, 7 * 86400))],
    )).rows as Array<{ t: string; es: number }>;
    let streaming = 0, lastStream: number | null = null;
    rows.forEach((r, i) => {
      if (r.es > 0) {
        lastStream = Number(r.t);
        const next = rows[i + 1];
        streaming += Math.min(next ? Number(next.t) - Number(r.t) : 15, 60);
      }
    });
    const now = Math.round(Date.now() / 1000);
    out.usage = {
      runningMin: Math.round(up / 60),
      streamingMin: Math.round(streaming / 60),
      idleMin: lastStream != null ? Math.round((now - lastStream) / 60) : Math.round(up / 60),
      everStreamed: lastStream != null,
      autoStopMin: machine.auto_stop_minutes ?? null,
      costPerHour: Number(machine.cost_per_hour) || null,
    };
    const catalog = (CATALOGS as any)[machine.provider];
    const egress = catalog?.regions?.find((r: any) => r.id === machine.region)?.egressPerGb;
    if (typeof egress === 'number') out.egressPerGb = egress;
    const d = (await query(
      `SELECT MIN(EXTRACT(EPOCH FROM t))::bigint AS t0, MAX(EXTRACT(EPOCH FROM t))::bigint AS t1,
              (ARRAY_AGG((data->'d'->>0)::float ORDER BY t ASC))[1] AS u0, (ARRAY_AGG((data->'d'->>0)::float ORDER BY t DESC))[1] AS u1
         FROM machine_telemetry WHERE machine_id = $1 AND t > NOW() - INTERVAL '24 hours' AND data ? 'd'`,
      [machine.id],
    )).rows[0];
    const span = d ? Number(d.t1) - Number(d.t0) : 0;
    if (d && span >= 3 * 3600 && latest.d?.[1]) {
      const perDay = ((Number(d.u1) - Number(d.u0)) / span) * 86400;
      const days = perDay > 0.5 ? (latest.d[1] - latest.d[0]) / perDay : null;
      if (days != null && days <= 60) out.diskFullDays = Math.max(0, Math.round(days * 10) / 10);
    }
  } catch { /* extras are optional */ }
  return out;
}

/** The Monitor view for one machine. */
export async function live(userId: string, machine: any, minutes = 30): Promise<{
  samples: TelemetrySample[]; latest: TelemetrySample | null; alerts: TelemetryAlert[]; readAt: string | null; note?: string;
  usage?: unknown; egressPerGb?: number; diskFullDays?: number;
}> {
  const mins = Math.max(5, Math.min(7 * 24 * 60, Math.round(minutes) || 30));
  let note: string | undefined;
  if (machine.status === 'running' && machine.instance_id && !/^(pending|shelved):/.test(machine.instance_id)) {
    const age = Date.now() - (lastRead.get(machine.id) || 0);
    const minAge = machine.provider === 'oracle' ? 60_000 : 12_000;
    if (age > minAge) {
      try { await ingest(userId, machine); } catch (e: any) { note = `Couldn’t read the machine’s console just now: ${e?.message || e}`; }
    }
  }
  // Long windows are thinned to ~400 points so the page stays light.
  const step = Math.max(1, Math.round((mins * 4) / 400));
  const rows = (await query(
    `SELECT data FROM (SELECT data, row_number() OVER (ORDER BY t) AS n FROM machine_telemetry
       WHERE machine_id = $1 AND t > NOW() - ($2 || ' minutes')::interval) x WHERE n % $3 = 0 OR n = 1 ORDER BY (data->>'t')::bigint`,
    [machine.id, String(mins), step],
  )).rows.map((r: any) => r.data as TelemetrySample);
  const latestRow = (await query('SELECT data FROM machine_telemetry WHERE machine_id = $1 ORDER BY t DESC LIMIT 2', [machine.id])).rows;
  const latest = (latestRow[0]?.data as TelemetrySample) || null;
  // Sunshine's errors come once a minute: carry the newest report onto the latest sample.
  if (latest && !latest.sn) {
    const sn = (await query(`SELECT data->'sn' AS sn FROM machine_telemetry WHERE machine_id = $1 AND data ? 'sn' AND data->'sn' <> 'null'::jsonb ORDER BY t DESC LIMIT 1`, [machine.id])).rows[0]?.sn;
    if (sn) latest.sn = sn;
  }
  if (!latest && !note) {
    note = machine.status === 'running'
      ? 'No telemetry yet. Machines report every 15 seconds once their setup has started; machines launched before this feature need the newest on-machine script (Google: the “Update script” button next to Stop; other clouds: Shelve, then Restore).'
      : 'Start the machine to see live telemetry.';
  }
  // Stream settings are logged once a minute, only while streaming: carry the newest onto the latest sample.
  if (latest && !latest.ss && latest.g?.es) {
    const ss = (await query(`SELECT data->'ss' AS ss FROM machine_telemetry WHERE machine_id = $1 AND data ? 'ss' AND data->'ss' <> 'null'::jsonb AND t > NOW() - INTERVAL '3 hours' ORDER BY t DESC LIMIT 1`, [machine.id])).rows[0]?.ss;
    if (ss) latest.ss = ss;
  }
  const extras = latest ? await usageFor(machine, latest) : {};
  const at = lastRead.get(machine.id);
  return { samples: rows, latest, alerts: alertsFor(latest, latestRow[1]?.data || null), readAt: at ? new Date(at).toISOString() : null, ...extras, ...(note ? { note } : {}) };
}

/** Every minute: store new samples for each running machine; once an hour, drop rows older than 7 days. */
let runs = 0;
export async function collectTelemetryJob(): Promise<void> {
  runs++;
  const machines = (await query(
    `SELECT id, user_id, provider, instance_id FROM machines
      WHERE status = 'running' AND instance_id IS NOT NULL AND instance_id !~ '^(pending|shelved):'`,
  )).rows;
  await Promise.all(machines
    .filter((m: any) => m.provider !== 'oracle' || runs % 5 === 0)
    .filter((m: any) => Date.now() - (lastRead.get(m.id) || 0) > 45_000)
    .map((m: any) => ingest(m.user_id, m).catch(() => 0)));
  if (runs % 60 === 1) await query(`DELETE FROM machine_telemetry WHERE t < NOW() - INTERVAL '7 days'`).catch(() => undefined);
}
