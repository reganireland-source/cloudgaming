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
  if ((s.cm ?? 0) >= 97) a.push({ level: 'info', key: 'cpu', text: `CPU maxed out (peak ${s.cm}%) — a bigger machine may help CPU-heavy games` });
  if ((s.x ?? 0) > 0) a.push({ level: 'critical', key: 'xid', text: `${s.x} NVIDIA GPU error${s.x === 1 ? '' : 's'} (Xid) since boot${s.xl ? `: ${s.xl.replace(/^NVRM: /, '')}` : ''}` });
  if ((s.o ?? 0) > 0) a.push({ level: 'critical', key: 'oom', text: `${s.o} program${s.o === 1 ? ' was' : 's were'} killed for lack of memory since boot` });
  if (s.f?.length) a.push({ level: 'warning', key: 'failed', text: `Failed service${s.f.length === 1 ? '' : 's'}: ${s.f.join(', ')}` });
  const down = (s.k || []).filter((k) => !/:\s*Up\b/.test(k));
  if (down.length) a.push({ level: 'warning', key: 'containers', text: `Not running: ${down.join(' · ')}` });
  if (s.k?.some((k) => /unhealthy/i.test(k))) a.push({ level: 'warning', key: 'unhealthy', text: 'The streaming container reports itself unhealthy' });
  if (prev && s.up != null && prev.up != null && s.up < prev.up) a.push({ level: 'info', key: 'reboot', text: 'The machine restarted recently' });
  return a;
}

/** The Monitor view for one machine. */
export async function live(userId: string, machine: any, minutes = 30): Promise<{
  samples: TelemetrySample[]; latest: TelemetrySample | null; alerts: TelemetryAlert[]; readAt: string | null; note?: string;
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
  if (!latest && !note) {
    note = machine.status === 'running'
      ? 'No telemetry yet. Machines report every 15 seconds once their setup has started; machines launched before this feature need the newest on-machine script (Google: the “Update script” button next to Stop; other clouds: Shelve, then Restore).'
      : 'Start the machine to see live telemetry.';
  }
  const at = lastRead.get(machine.id);
  return { samples: rows, latest, alerts: alertsFor(latest, latestRow[1]?.data || null), readAt: at ? new Date(at).toISOString() : null, ...(note ? { note } : {}) };
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
