/**
 * ============================================================================
 * src/services/LocalMachineService.ts — YOUR OWN PCs (Windows + Sunshine)
 * ============================================================================
 *
 * A "local machine" is a PC at home. GGGH can't reach into a home network from
 * the cloud, so a small AGENT on the PC connects OUT to GGGH (HTTPS long-poll,
 * providers/shared/localAgent.ts) and picks up queued commands. Nothing is
 * opened on the PC's side.
 *
 * Two tokens per machine, both stored only as SHA-256 hashes:
 *   agent token     the agent's login. Sees only its own commands.
 *   launcher token  goes into the generated Moonlight command on your Mac
 *                   (also kept encrypted so the app can show it again). It may
 *                   only ask for the screen to match / be put back: it can't
 *                   power the PC off or run anything.
 *
 * Commands are a fixed list. "script" (a PowerShell command you type) is off
 * until switched on per PC, and every command and its result is kept.
 * ============================================================================
 */

import crypto from 'crypto';
import dns from 'dns';
import http from 'http';
import net from 'net';
import { getSshKeys } from './SshAccessService';
import { query } from '../config/database';
import { MachineRequestError } from './MachineService';
import { encryptCredentials, decryptCredentials, encryptionReady } from './CredentialService';
import { SUNSHINE_SETTINGS, evaluateReport, reportText, stats } from './LocalDiagnostics';
import { AGENT_SHA256, BOOT_SHA256 } from '../providers/shared/localAgent';

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const newToken = (prefix: string) => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
const TOKEN_RE = /^cg[lm]_[A-Za-z0-9_-]{20,}$/;

export const ONLINE_WITHIN_MS = 45_000;
const QUEUE_TTL_MS = 5 * 60_000;     // a command nobody picked up in 5 minutes is dropped
const SENT_TTL_MS = 3 * 60_000;      // picked up but never answered
const POLL_HOLD_MS = 25_000;         // how long the agent's request waits for a command
const MAX_SCRIPT = 4000;

/** What the app may ask for, and what the launcher token may ask for. */
export type CommandKind = 'refresh' | 'sleep' | 'restart' | 'shutdown' | 'sunshine-restart' | 'sunshine-pin' | 'display-set' | 'display-headless' | 'display-restore' | 'script'
  | 'diagnose' | 'record' | 'logs' | 'power-plan' | 'gpu-clocks' | 'sunshine-config' | 'sunshine-config-restore' | 'away-prepare' | 'ssh-setup' | 'tunnel-open';
const APP_KINDS: CommandKind[] = ['refresh', 'sleep', 'restart', 'shutdown', 'sunshine-restart', 'sunshine-pin', 'display-set', 'display-headless', 'display-restore', 'script',
  'diagnose', 'record', 'logs', 'power-plan', 'gpu-clocks', 'sunshine-config', 'sunshine-config-restore', 'away-prepare', 'ssh-setup'];
const LAUNCHER_KINDS: CommandKind[] = ['display-set', 'display-headless', 'display-restore'];

const MAC_RE = /^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
export const normalizeMac = (m: unknown): string | null =>
  typeof m === 'string' && MAC_RE.test(m.trim()) ? m.trim().toUpperCase().replace(/-/g, ':') : null;
const cleanIp = (v: unknown): string | null => (typeof v === 'string' && IPV4_RE.test(v.trim()) ? v.trim() : null);

export interface LocalMachineView {
  id: string; name: string; lanIp: string | null; mac: string | null;
  online: boolean; lastSeenAt: string | null; scriptEnabled: boolean; displayMode: 'mirror' | 'headless';
  wanHost: string | null; awayOk: boolean; awayCheckedAt: string | null; sshEnabled: boolean;
  status: Record<string, any> | null; createdAt: string;
}

const COLUMNS = 'id, name, lan_ip, mac_address, script_enabled, display_mode, wan_host, away_ok, away_checked_at, ssh_enabled, status, last_seen_at, created_at';
const view = (r: any): LocalMachineView => ({
  id: r.id, name: r.name, lanIp: r.lan_ip, mac: r.mac_address,
  online: !!r.last_seen_at && Date.now() - new Date(r.last_seen_at).getTime() < ONLINE_WITHIN_MS,
  lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
  scriptEnabled: !!r.script_enabled, displayMode: r.display_mode === 'headless' ? 'headless' : 'mirror',
  wanHost: r.wan_host || null, awayOk: !!r.away_ok, awayCheckedAt: r.away_checked_at ? new Date(r.away_checked_at).toISOString() : null, sshEnabled: !!r.ssh_enabled, status: r.status || null, createdAt: new Date(r.created_at).toISOString(),
});

async function owned(userId: string, id: string) {
  const row = (await query('SELECT * FROM local_machines WHERE id = $1 AND user_id = $2', [id, userId])).rows[0];
  if (!row) throw new MachineRequestError(404, 'That local machine wasn\'t found.');
  return row;
}

function checkName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n.length > 40) throw new MachineRequestError(400, 'Give the PC a name of 1–40 characters.', 'For example "Gaming PC".');
  return n;
}

// ---------------------------------------------------------------------------
// The app's side
// ---------------------------------------------------------------------------

export async function listLocalMachines(userId: string): Promise<LocalMachineView[]> {
  return (await query(`SELECT ${COLUMNS} FROM local_machines WHERE user_id = $1 ORDER BY created_at`, [userId])).rows.map(view);
}

/** A new machine. The agent token is returned ONCE (only its hash is kept). */
export async function createLocalMachine(userId: string, input: { name?: unknown; lanIp?: unknown; mac?: unknown }) {
  if (!encryptionReady()) throw new MachineRequestError(503, 'The server\'s encryption key isn\'t set up, so nothing was saved.', 'Set CREDENTIALS_ENCRYPTION_KEY on the backend (see the Config page).');
  const name = checkName(input.name);
  const count = Number((await query('SELECT COUNT(*) AS n FROM local_machines WHERE user_id = $1', [userId])).rows[0].n);
  if (count >= 10) throw new MachineRequestError(400, 'That\'s the limit of 10 local machines.');
  const agentToken = newToken('cgl'), launcherToken = newToken('cgm');
  const id = crypto.randomUUID();
  const row = (await query(
    `INSERT INTO local_machines (id, user_id, name, lan_ip, mac_address, agent_token_hash, launcher_token_hash, launcher_token_enc, ssh_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) RETURNING ${COLUMNS}`,
    [id, userId, name, cleanIp(input.lanIp), normalizeMac(input.mac), hash(agentToken), hash(launcherToken), encryptCredentials(userId, `local:${id}`, { launcherToken })],
  )).rows[0];
  return { machine: view(row), agentToken };
}

export async function updateLocalMachine(userId: string, id: string, patch: { name?: unknown; lanIp?: unknown; mac?: unknown; scriptEnabled?: unknown; displayMode?: unknown; wanHost?: unknown; sshEnabled?: unknown }) {
  await owned(userId, id);
  const sets: string[] = []; const vals: any[] = [id, userId];
  const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (patch.name !== undefined) add('name', checkName(patch.name));
  if (patch.lanIp !== undefined) {
    if (patch.lanIp !== '' && patch.lanIp !== null && !cleanIp(patch.lanIp)) throw new MachineRequestError(400, 'That isn\'t an IPv4 address.', 'Like 192.168.1.20.');
    add('lan_ip', cleanIp(patch.lanIp));
  }
  if (patch.mac !== undefined) {
    if (patch.mac !== '' && patch.mac !== null && !normalizeMac(patch.mac)) throw new MachineRequestError(400, 'That isn\'t a MAC address.', 'Like AA:BB:CC:DD:EE:FF.');
    add('mac_address', normalizeMac(patch.mac));
  }
  if (patch.scriptEnabled !== undefined) add('script_enabled', patch.scriptEnabled === true);
  if (patch.displayMode !== undefined) {
    if (patch.displayMode !== 'mirror' && patch.displayMode !== 'headless') throw new MachineRequestError(400, 'The screen mode is "mirror" or "headless".');
    add('display_mode', patch.displayMode);
  }
  if (patch.sshEnabled !== undefined) add('ssh_enabled', patch.sshEnabled === true);
  if (patch.wanHost !== undefined) {
    const h = typeof patch.wanHost === 'string' ? patch.wanHost.trim().toLowerCase() : '';
    if (h && !(net.isIP(h) || /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h))) throw new MachineRequestError(400, 'That isn\'t an internet address or name.', 'Like 203.0.113.7 or myhome.example.com. Leave it empty to use the address GGGH sees.');
    add('wan_host', h || null);
    sets.push('away_ok = FALSE'); // a new address has not been tested yet
  }
  if (!sets.length) throw new MachineRequestError(400, 'Nothing to change.');
  const row = (await query(`UPDATE local_machines SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`, vals)).rows[0];
  return view(row);
}

export async function deleteLocalMachine(userId: string, id: string) {
  await owned(userId, id);
  await query('DELETE FROM local_machines WHERE id = $1 AND user_id = $2', [id, userId]);
}

/** New agent token (the old one stops working at once). Shown once. */
export async function rotateAgentToken(userId: string, id: string): Promise<string> {
  await owned(userId, id);
  const token = newToken('cgl');
  await query('UPDATE local_machines SET agent_token_hash = $3 WHERE id = $1 AND user_id = $2', [id, userId, hash(token)]);
  return token;
}

/** What the generated Moonlight command needs (this user's own machine only). */
export async function launcherInfo(userId: string, id: string) {
  const row = await owned(userId, id);
  const { launcherToken } = decryptCredentials(userId, `local:${id}`, row.launcher_token_enc);
  return { launcherToken: launcherToken as string, lanIp: row.lan_ip as string | null, mac: row.mac_address as string | null, awayOk: !!row.away_ok };
}

function checkArgs(kind: CommandKind, args: any, scriptEnabled: boolean): Record<string, unknown> {
  const a = args && typeof args === 'object' ? args : {};
  switch (kind) {
    case 'sunshine-pin': {
      if (!/^\d{4}$/.test(String(a.pin))) throw new MachineRequestError(400, 'The pairing PIN is 4 digits.');
      return { pin: String(a.pin), name: String(a.name || 'GGGH').replace(/[^\w .-]/g, '').slice(0, 30) || 'GGGH' };
    }
    case 'display-set':
    case 'display-headless': {
      const w = Number(a.width), h = Number(a.height), fps = Number(a.fps || 60);
      if (!(w >= 640 && w <= 7680 && h >= 480 && h <= 4320 && fps >= 24 && fps <= 240)) throw new MachineRequestError(400, 'That screen size isn\'t sensible.', 'Width 640–7680, height 480–4320, 24–240 fps.');
      return { width: Math.round(w), height: Math.round(h), fps: Math.round(fps) };
    }
    case 'script': {
      if (!scriptEnabled) throw new MachineRequestError(403, 'Running a script is switched off for this PC.', 'Switch it on in the PC\'s settings first.');
      const s = typeof a.script === 'string' ? a.script.trim() : '';
      if (!s || s.length > MAX_SCRIPT) throw new MachineRequestError(400, `Type a PowerShell command (up to ${MAX_SCRIPT} characters).`);
      return { script: s };
    }
    case 'record': {
      const sec = Math.round(Number(a.seconds || 60));
      if (!(sec >= 10 && sec <= 300)) throw new MachineRequestError(400, 'A recording is 10–300 seconds.');
      return { seconds: sec };
    }
    case 'logs': {
      const n = Math.round(Number(a.lines || 300));
      if (!(n >= 50 && n <= 2000)) throw new MachineRequestError(400, 'Ask for 50–2000 log lines.');
      return { lines: n };
    }
    case 'power-plan':
      if (a.plan !== 'high' && a.plan !== 'restore') throw new MachineRequestError(400, 'The plan is "high" or "restore".');
      return { plan: a.plan };
    case 'gpu-clocks':
      if (a.action !== 'lock' && a.action !== 'reset') throw new MachineRequestError(400, 'The action is "lock" or "reset".');
      return { action: a.action };
    case 'away-prepare': return {};
    case 'ssh-setup': {
      const keys = (Array.isArray(a.keys) ? a.keys : []).map((k: unknown) => String(k).trim()).filter((k: string) => /^(ssh-(rsa|ed25519)|ecdsa-sha2-[a-z0-9]+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/=]+( [^\r\n]*)?$/.test(k) && k.length <= 1000).slice(0, 20);
      return { keys };
    }
    case 'tunnel-open': {
      const port = Math.round(Number(a.port));
      if (!/^[0-9a-f-]{36}$/i.test(String(a.sid)) || !(port >= 1 && port <= 65535)) throw new MachineRequestError(400, 'Bad tunnel request.');
      return { sid: String(a.sid), port };
    }
    case 'sunshine-config': {
      const rule = SUNSHINE_SETTINGS[String(a.key)];
      if (!rule) throw new MachineRequestError(400, 'That Sunshine setting can\'t be changed from here.', `Allowed: ${Object.keys(SUNSHINE_SETTINGS).join(', ')}.`);
      if (!rule.re.test(String(a.value))) throw new MachineRequestError(400, `That isn't a valid value for ${a.key}.`);
      return { key: String(a.key), value: String(a.value) };
    }
    default: return {};
  }
}

async function enqueue(row: any, kind: CommandKind, args: unknown, source: 'app' | 'launcher') {
  const clean = checkArgs(kind, args, !!row.script_enabled);
  const c = (await query(
    'INSERT INTO local_commands (machine_id, kind, args, source) VALUES ($1, $2, $3, $4) RETURNING id, kind, status, created_at',
    [row.id, kind, JSON.stringify(clean), source],
  )).rows[0];
  return { id: c.id as string, kind: c.kind as string };
}

export async function sendLocalCommand(userId: string, id: string, kind: unknown, args?: unknown) {
  const row = await owned(userId, id);
  if (!APP_KINDS.includes(kind as CommandKind)) throw new MachineRequestError(400, 'That isn\'t something this PC can be asked to do.');
  if (kind === 'ssh-setup') args = { keys: await getSshKeys(userId) }; // the account's saved public keys; never typed here
  return enqueue(row, kind as CommandKind, args, 'app');
}

export async function getLocalCommand(userId: string, id: string, commandId: string) {
  await owned(userId, id);
  if (!/^[0-9a-f-]{36}$/i.test(commandId)) throw new MachineRequestError(404, 'No such command.');
  const c = (await query('SELECT id, kind, status, result, created_at, finished_at FROM local_commands WHERE id = $1 AND machine_id = $2', [commandId, id])).rows[0];
  if (!c) throw new MachineRequestError(404, 'No such command.');
  return { id: c.id, kind: c.kind, status: c.status, result: c.result, createdAt: c.created_at, finishedAt: c.finished_at };
}

/** The audit trail: what was asked of this PC, when, and what came back. */
export async function recentLocalCommands(userId: string, id: string, limit = 20) {
  await owned(userId, id);
  const rows = (await query(
    'SELECT id, kind, args, source, status, result, created_at, finished_at FROM local_commands WHERE machine_id = $1 ORDER BY created_at DESC LIMIT $2',
    [id, Math.min(Math.max(limit, 1), 100)],
  )).rows;
  return rows.map((c) => ({ id: c.id, kind: c.kind, args: c.args, source: c.source, status: c.status, result: c.result, createdAt: c.created_at, finishedAt: c.finished_at }));
}

// ---------------------------------------------------------------------------
// The agent's side (public routes, Bearer token)
// ---------------------------------------------------------------------------

async function byToken(token: string, col: 'agent_token_hash' | 'launcher_token_hash') {
  if (!TOKEN_RE.test(token)) return null;
  return (await query(`SELECT * FROM local_machines WHERE ${col} = $1`, [hash(token)])).rows[0] || null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The agent says hello (with its status) and waits up to ~25 s for work.
 * null = unknown token. Returns the commands to run (they are marked "sent").
 */
/**
 * Which of the agent's own files differ from what GGGH serves now (it reports
 * their SHA-256). An agent that can update itself ("canUpdate") is told to
 * fetch them; it checks the hash again after downloading.
 */
export function updatesFor(st: any): Array<{ file: 'agent' | 'boot'; sha256: string }> {
  if (!st || st.canUpdate !== true) return [];
  const out: Array<{ file: 'agent' | 'boot'; sha256: string }> = [];
  if (typeof st.agentSha === 'string' && st.agentSha.toLowerCase() !== AGENT_SHA256) out.push({ file: 'agent', sha256: AGENT_SHA256 });
  if (typeof st.bootSha === 'string' && st.bootSha.toLowerCase() !== BOOT_SHA256) out.push({ file: 'boot', sha256: BOOT_SHA256 });
  return out;
}

const SAMPLE_EVERY_MS = 25_000;
const SAMPLE_KEEP_MS = 25 * 3600_000;
const lastSampleAt = new Map<string, number>();
const numOr = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The agent's status as one trend-line sample, in the shape the Performance page's telemetry panel reads. */
export function sampleFromStatus(st: any): Record<string, unknown> {
  const gpu = st?.gpu && typeof st.gpu === 'object' ? st.gpu : null;
  const out: Record<string, unknown> = { t: Math.round(Date.now() / 1000) };
  const c = numOr(st?.cpuPercent); if (c !== undefined) out.c = c;
  const ram = numOr(st?.ramGb), free = numOr(st?.ramFreeGb);
  if (ram !== undefined && free !== undefined) out.m = [Math.round((ram - free) * 10) / 10, ram];
  const du = numOr(st?.diskUsedGb), dt = numOr(st?.diskTotalGb); if (du !== undefined && dt !== undefined) out.d = [du, dt];
  const no = numOr(st?.txMbps), ni = numOr(st?.rxMbps); if (no !== undefined) out.no = no; if (ni !== undefined) out.ni = ni;
  const up = numOr(st?.uptimeHours); if (up !== undefined) out.up = Math.round(up * 3600);
  if (gpu) {
    const g: Record<string, unknown> = {};
    const pairs: Array<[string, unknown]> = [['u', gpu.util], ['tp', gpu.tempC], ['vu', gpu.vramUsedMb], ['vt', gpu.vramTotalMb], ['pw', gpu.powerW], ['pl', gpu.powerLimitW], ['es', gpu.encoders]];
    for (const [k, v] of pairs) { const n = numOr(v); if (n !== undefined) g[k] = n; }
    out.g = g;
  }
  return out;
}

async function recordSample(machineId: string, st: any) {
  const now = Date.now();
  if (now - (lastSampleAt.get(machineId) || 0) < SAMPLE_EVERY_MS) return;
  lastSampleAt.set(machineId, now);
  try {
    await query('INSERT INTO local_samples (machine_id, data) VALUES ($1, $2)', [machineId, JSON.stringify(sampleFromStatus(st))]);
    if (Math.random() < 0.02) await query('DELETE FROM local_samples WHERE machine_id = $1 AND at < $2', [machineId, new Date(now - SAMPLE_KEEP_MS)]);
  } catch (e) { console.error('local sample not saved:', (e as Error).message); }
}

export async function agentPoll(token: string, report: any, holdMs = POLL_HOLD_MS, stepMs = 1500, clientIp?: string) {
  const m = await byToken(token, 'agent_token_hash');
  if (!m) return null;
  const st = report && typeof report === 'object' ? report : {};
  const update = updatesFor(st);
  const safe: any = JSON.stringify(st).length <= 20_000 ? { ...st } : {};
  const seenIp = clientIp ? clientIp.replace(/^::ffff:/, '') : '';
  if (seenIp && net.isIP(seenIp)) safe.publicIp = seenIp; // what the internet sees of the PC's home connection
  await query(
    `UPDATE local_machines SET last_seen_at = NOW(), status = $2,
       lan_ip = COALESCE($3, lan_ip), mac_address = COALESCE($4, mac_address) WHERE id = $1`,
    [m.id, JSON.stringify(safe), cleanIp(st.lanIp), normalizeMac(st.mac)],
  );
  await recordSample(m.id, safe);
  await maybeSetupSsh(m, safe);
  // Tidy up: commands nobody picked up, or that were picked up and never answered.
  await query(`UPDATE local_commands SET status = 'expired', finished_at = NOW() WHERE machine_id = $1 AND status = 'queued' AND created_at < $2`, [m.id, new Date(Date.now() - QUEUE_TTL_MS)]);
  await query(`UPDATE local_commands SET status = 'failed', result = 'The PC never answered.', finished_at = NOW() WHERE machine_id = $1 AND status = 'sent' AND sent_at < $2`, [m.id, new Date(Date.now() - SENT_TTL_MS)]);
  const until = Date.now() + holdMs;
  for (;;) {
    const rows = (await query(
      `UPDATE local_commands SET status = 'sent', sent_at = NOW()
        WHERE id IN (SELECT id FROM local_commands WHERE machine_id = $1 AND status = 'queued' ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED)
        RETURNING id, kind, args, created_at`, [m.id])).rows;
    if (rows.length) {
      rows.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
      return { commands: rows.map((r) => ({ id: r.id as string, kind: r.kind as string, args: r.args })), pollSeconds: 1, update };
    }
    if (Date.now() >= until || update.length) return { commands: [], pollSeconds: 1, update };
    await sleep(Math.min(stepMs, Math.max(0, until - Date.now())));
  }
}

/** The agent reports how a command went. false = not this agent's command. */
export async function agentResult(token: string, commandId: string, ok: boolean, message: unknown): Promise<boolean> {
  const m = await byToken(token, 'agent_token_hash');
  if (!m || !/^[0-9a-f-]{36}$/i.test(String(commandId))) return false;
  const text = String(message ?? '').slice(0, 4000);
  const r = await query(
    `UPDATE local_commands SET status = $3, result = $4, finished_at = NOW() WHERE id = $1 AND machine_id = $2 AND status = 'sent'`,
    [commandId, m.id, ok ? 'done' : 'failed', text],
  );
  return (r.rowCount || 0) > 0;
}

// ---------------------------------------------------------------------------
// The generated Moonlight command's side (public routes, launcher token)
// ---------------------------------------------------------------------------

/** Ask the PC to match the screen (or put it back) and wait for the answer. */
export async function launcherScreen(token: string, action: 'set' | 'headless' | 'restore', args: { width?: unknown; height?: unknown; fps?: unknown }, waitMs = 25_000) {
  const m = await byToken(token, 'launcher_token_hash');
  if (!m) return null;
  const online = !!m.last_seen_at && Date.now() - new Date(m.last_seen_at).getTime() < ONLINE_WITHIN_MS;
  if (!online) return { online: false, ok: false, message: 'The PC\'s agent isn\'t connected to GGGH, so its screen was left as it is.' };
  const kind: CommandKind = action === 'set' ? 'display-set' : action === 'headless' ? 'display-headless' : 'display-restore';
  if (!LAUNCHER_KINDS.includes(kind)) return null;
  const cmd = await enqueue(m, kind, args, 'launcher');
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const c = (await query('SELECT status, result FROM local_commands WHERE id = $1', [cmd.id])).rows[0];
    if (c && (c.status === 'done' || c.status === 'failed' || c.status === 'expired')) return { online: true, ok: c.status === 'done', message: c.result || c.status };
    await sleep(400);
  }
  return { online: true, ok: false, message: 'The PC didn\'t answer in time.' };
}

// ---------------------------------------------------------------------------
// Reports, live samples and the heartbeat (the agent's long jobs)
// ---------------------------------------------------------------------------

/** A long job (a recording, pairing) keeps the machine "online" with this. */
export async function agentHeartbeat(token: string): Promise<boolean> {
  const m = await byToken(token, 'agent_token_hash');
  if (!m) return false;
  await query('UPDATE local_machines SET last_seen_at = NOW() WHERE id = $1', [m.id]);
  return true;
}

const MAX_REPORT_CHARS = 450_000;
const REPORT_KINDS = ['diagnose', 'record', 'logs'];

/** The agent uploads what it measured. Returns the report's id, or null if refused. */
export async function agentReport(token: string, commandId: string, kind: string, data: unknown): Promise<string | null> {
  const m = await byToken(token, 'agent_token_hash');
  if (!m || !REPORT_KINDS.includes(kind) || !/^[0-9a-f-]{36}$/i.test(String(commandId))) return null;
  const json = JSON.stringify(data ?? {});
  if (json.length > MAX_REPORT_CHARS) return null;
  const own = (await query('SELECT 1 FROM local_commands WHERE id = $1 AND machine_id = $2', [commandId, m.id])).rows[0];
  if (!own) return null;
  const id = (await query('INSERT INTO local_reports (machine_id, kind, command_id, data) VALUES ($1, $2, $3, $4) RETURNING id', [m.id, kind, commandId, json])).rows[0].id as string;
  await query(`DELETE FROM local_reports WHERE machine_id = $1 AND kind = $2 AND id NOT IN
    (SELECT id FROM local_reports WHERE machine_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 10)`, [m.id, kind]);
  return id;
}

export async function listReports(userId: string, id: string, kind?: string) {
  await owned(userId, id);
  const rows = (await query(
    `SELECT id, kind, command_id, created_at FROM local_reports WHERE machine_id = $1 ${kind ? 'AND kind = $2' : ''} ORDER BY created_at DESC LIMIT 20`,
    kind ? [id, kind] : [id])).rows;
  return rows.map((r) => ({ id: r.id, kind: r.kind, commandId: r.command_id, createdAt: r.created_at }));
}

/** One report, with the plain-English findings worked out now (so rule improvements reach old reports). */
export async function getReport(userId: string, id: string, reportId: string) {
  const machine = await owned(userId, id);
  if (!/^[0-9a-f-]{36}$/i.test(reportId)) throw new MachineRequestError(404, 'No such report.');
  const r = (await query('SELECT id, kind, data, created_at FROM local_reports WHERE id = $1 AND machine_id = $2', [reportId, id])).rows[0];
  if (!r) throw new MachineRequestError(404, 'No such report.');
  const findings = evaluateReport(r.kind, r.data);
  const series: Record<string, ReturnType<typeof stats>> = {};
  if (r.kind === 'record') for (const [k, v] of Object.entries(r.data?.series || {})) if (Array.isArray(v)) series[k] = stats(v.filter((x) => typeof x === 'number'));
  const createdAt = new Date(r.created_at).toISOString();
  return { id: r.id, kind: r.kind, createdAt, data: r.data, findings, series, text: reportText(machine.name, r.kind, createdAt, r.data, findings) };
}

// Live samples while a recording runs: kept in memory (they only matter for the next minute).
const live = new Map<string, { seq: number; samples: Array<Record<string, unknown> & { seq: number }>; at: number }>();
const LIVE_KEEP = 400;

export async function agentLive(token: string, samples: unknown): Promise<boolean> {
  const m = await byToken(token, 'agent_token_hash');
  if (!m) return false;
  await query('UPDATE local_machines SET last_seen_at = NOW() WHERE id = $1', [m.id]);
  const buf = live.get(m.id) || { seq: 0, samples: [], at: 0 };
  for (const x of (Array.isArray(samples) ? samples : []).slice(0, 50)) {
    if (!x || typeof x !== 'object') continue;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>).slice(0, 20)) if (typeof v === 'number' || typeof v === 'boolean') clean[k] = v;
    buf.samples.push({ ...clean, seq: ++buf.seq });
  }
  if (buf.samples.length > LIVE_KEEP) buf.samples.splice(0, buf.samples.length - LIVE_KEEP);
  buf.at = Date.now();
  live.set(m.id, buf);
  return true;
}

/** Samples newer than `since` (a sequence number), for the page's live charts. */
export async function getLive(userId: string, id: string, since = 0) {
  await owned(userId, id);
  const buf = live.get(id);
  if (!buf) return { samples: [], seq: 0, active: false };
  return { samples: buf.samples.filter((x) => x.seq > since), seq: buf.seq, active: Date.now() - buf.at < 8000 };
}

// ---------------------------------------------------------------------------
// Trend lines for the Performance page (same shape as a cloud machine's telemetry)
// ---------------------------------------------------------------------------

export async function localTelemetry(userId: string, id: string, minutes = 60) {
  const row = await owned(userId, id);
  const mins = Math.min(Math.max(Math.round(minutes) || 60, 5), 1440);
  const samples = (await query(
    'SELECT data FROM local_samples WHERE machine_id = $1 AND at > $2 ORDER BY at ASC LIMIT 3000',
    [id, new Date(Date.now() - mins * 60_000)],
  )).rows.map((r) => r.data);
  const latest = samples.length ? samples[samples.length - 1] : null;
  const st = row.status || {};
  const alerts: Array<{ level: 'critical' | 'warning' | 'info'; key: string; text: string }> = [];
  const online = !!row.last_seen_at && Date.now() - new Date(row.last_seen_at).getTime() < ONLINE_WITHIN_MS;
  if (online) {
    const temp = numOr(st.gpu?.tempC);
    if (temp !== undefined && temp >= 87) alerts.push({ level: 'critical', key: 'gpu-hot', text: `The GPU is at ${temp} °C and will slow itself down.` });
    else if (temp !== undefined && temp >= 80) alerts.push({ level: 'warning', key: 'gpu-warm', text: `The GPU is running hot (${temp} °C).` });
    if (st.wired === false) alerts.push({ level: 'warning', key: 'wifi', text: 'The PC is on Wi-Fi, the most common cause of stutter. Use a network cable.' });
    if (st.sunshine && st.sunshine !== 'Running') alerts.push({ level: 'warning', key: 'sunshine', text: st.sunshine === 'NotInstalled' ? 'Sunshine is not installed on the PC.' : `Sunshine is ${String(st.sunshine).toLowerCase()}, so nobody can stream.` });
    const ram = numOr(st.ramGb), free = numOr(st.ramFreeGb);
    if (ram && free !== undefined && 1 - free / ram >= 0.92) alerts.push({ level: 'warning', key: 'ram', text: 'The PC is almost out of memory.' });
  }
  const note = online ? undefined : (row.last_seen_at ? 'The PC is off, asleep or cannot reach GGGH. The charts show its last readings.' : 'This PC has not connected to GGGH yet.');
  return { samples, latest, alerts, readAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null, note };
}

// ---------------------------------------------------------------------------
// Away access: is the PC's Sunshine reachable from the internet?
// ---------------------------------------------------------------------------

/** Only the open internet: never a private, loopback, link-local or shared (CGNAT) address. */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return !(l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb'));
  }
  return false;
}

/** The address a travelling Moonlight command should try: the typed one, else what GGGH saw the agent connect from. */
export function awayAddress(row: any): string | null {
  return row.wan_host || row.status?.publicIp || null;
}

const tcpOpen = (host: string, port: number, ms = 5000) => new Promise<boolean>((resolve) => {
  const s = net.connect({ host, port });
  const done = (ok: boolean) => { s.destroy(); resolve(ok); };
  s.setTimeout(ms, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

const sunshineAnswers = (host: string) => new Promise<boolean>((resolve) => {
  const req = http.get({ host, port: 47989, path: '/serverinfo', timeout: 6000 }, (r) => {
    let body = '';
    r.on('data', (d) => { if (body.length < 4000) body += d; });
    r.on('end', () => resolve((r.statusCode || 0) < 500 && /<root|HostName|uniqueid/i.test(body)));
  });
  req.on('timeout', () => { req.destroy(); resolve(false); });
  req.on('error', () => resolve(false));
});

/** From GGGH's server: does anything answer like Sunshine at the PC's internet address? */
export async function awayCheck(userId: string, id: string) {
  const row = await owned(userId, id);
  const host = awayAddress(row);
  if (!host) throw new MachineRequestError(400, 'GGGH does not know this PC\'s internet address yet.', 'It learns it when the agent next connects.');
  let ip = host;
  if (!net.isIP(host)) {
    try { ip = (await dns.promises.lookup(host)).address; } catch { return { host, ok: false, httpOk: false, httpsOk: false, message: `The name ${host} does not resolve to an address.` }; }
  }
  if (!isPublicAddress(ip)) {
    return { host, ok: false, httpOk: false, httpsOk: false, message: `${host} is a private address, not one the internet can reach. If it starts with 100.64 to 100.127 your provider shares one address between customers (CGNAT).` };
  }
  const [httpsOk, httpOk] = await Promise.all([tcpOpen(ip, 47984), sunshineAnswers(ip)]);
  const ok = httpOk || httpsOk;
  await query('UPDATE local_machines SET away_ok = $2, away_checked_at = NOW() WHERE id = $1', [id, ok]);
  const message = ok
    ? `Sunshine answers at ${host}. Away streaming should work.`
    : `Nothing answered at ${host}. Usual causes: the router is not forwarding the ports (UPnP off or unsupported), the provider shares one address between customers (CGNAT: the address your router shows differs from ${host}), or a firewall in between.`;
  return { host, ok, httpOk, httpsOk, message };
}

/** For the generated command (launcher token): where to find the PC from outside. */
export async function launcherAddress(token: string) {
  const m = await byToken(token, 'launcher_token_hash');
  if (!m) return null;
  const host = m.away_ok ? awayAddress(m) : null;
  return { host };
}

// ---------------------------------------------------------------------------
// SSH through GGGH
// ---------------------------------------------------------------------------

/** A PC with SSH switched on whose agent reports no running SSH server is told to set one up (at most every 30 minutes). */
async function maybeSetupSsh(row: any, st: any) {
  if (!row.ssh_enabled || !st?.ssh || st.ssh.running === true) return;
  const recent = (await query(`SELECT 1 FROM local_commands WHERE machine_id = $1 AND kind = 'ssh-setup' AND created_at > $2 LIMIT 1`, [row.id, new Date(Date.now() - 30 * 60_000)])).rows[0];
  if (recent) return;
  try { await enqueue(row, 'ssh-setup', { keys: await getSshKeys(row.user_id) }, 'app'); } catch { /* try again later */ }
}

/** A launcher-token holder asks for an SSH connection: returns what the tunnel hub needs, or why not. */
export async function sshTunnelRequest(launcherToken: string): Promise<{ ok: true; machineId: string; sid: string } | { ok: false; status: number; message: string }> {
  const m = await byToken(launcherToken, 'launcher_token_hash');
  if (!m) return { ok: false, status: 401, message: 'Unknown token.' };
  if (!m.ssh_enabled) return { ok: false, status: 403, message: 'SSH through GGGH is switched off for this PC.' };
  const online = !!m.last_seen_at && Date.now() - new Date(m.last_seen_at).getTime() < ONLINE_WITHIN_MS;
  if (!online) return { ok: false, status: 503, message: 'The PC is off or not connected to GGGH.' };
  const sid = crypto.randomUUID();
  const port = Number(m.status?.ssh?.port) || 22;
  await enqueue(m, 'tunnel-open', { sid, port }, 'launcher');
  return { ok: true, machineId: m.id, sid };
}

/** The agent dialling in for a tunnel: its token, and which machine it is. */
export async function tunnelAgentMachine(agentToken: string): Promise<string | null> {
  const m = await byToken(agentToken, 'agent_token_hash');
  return m ? (m.id as string) : null;
}
