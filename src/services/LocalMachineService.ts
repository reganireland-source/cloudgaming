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
import { query } from '../config/database';
import { MachineRequestError } from './MachineService';
import { encryptCredentials, decryptCredentials, encryptionReady } from './CredentialService';

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const newToken = (prefix: string) => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
const TOKEN_RE = /^cg[lm]_[A-Za-z0-9_-]{20,}$/;

export const ONLINE_WITHIN_MS = 45_000;
const QUEUE_TTL_MS = 5 * 60_000;     // a command nobody picked up in 5 minutes is dropped
const SENT_TTL_MS = 3 * 60_000;      // picked up but never answered
const POLL_HOLD_MS = 25_000;         // how long the agent's request waits for a command
const MAX_SCRIPT = 4000;

/** What the app may ask for, and what the launcher token may ask for. */
export type CommandKind = 'refresh' | 'sleep' | 'restart' | 'shutdown' | 'sunshine-restart' | 'sunshine-pin' | 'display-set' | 'display-restore' | 'script';
const APP_KINDS: CommandKind[] = ['refresh', 'sleep', 'restart', 'shutdown', 'sunshine-restart', 'sunshine-pin', 'display-set', 'display-restore', 'script'];
const LAUNCHER_KINDS: CommandKind[] = ['display-set', 'display-restore'];

const MAC_RE = /^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
export const normalizeMac = (m: unknown): string | null =>
  typeof m === 'string' && MAC_RE.test(m.trim()) ? m.trim().toUpperCase().replace(/-/g, ':') : null;
const cleanIp = (v: unknown): string | null => (typeof v === 'string' && IPV4_RE.test(v.trim()) ? v.trim() : null);

export interface LocalMachineView {
  id: string; name: string; lanIp: string | null; mac: string | null;
  online: boolean; lastSeenAt: string | null; scriptEnabled: boolean;
  status: Record<string, any> | null; createdAt: string;
}

const COLUMNS = 'id, name, lan_ip, mac_address, script_enabled, status, last_seen_at, created_at';
const view = (r: any): LocalMachineView => ({
  id: r.id, name: r.name, lanIp: r.lan_ip, mac: r.mac_address,
  online: !!r.last_seen_at && Date.now() - new Date(r.last_seen_at).getTime() < ONLINE_WITHIN_MS,
  lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
  scriptEnabled: !!r.script_enabled, status: r.status || null, createdAt: new Date(r.created_at).toISOString(),
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
    `INSERT INTO local_machines (id, user_id, name, lan_ip, mac_address, agent_token_hash, launcher_token_hash, launcher_token_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
    [id, userId, name, cleanIp(input.lanIp), normalizeMac(input.mac), hash(agentToken), hash(launcherToken), encryptCredentials(userId, `local:${id}`, { launcherToken })],
  )).rows[0];
  return { machine: view(row), agentToken };
}

export async function updateLocalMachine(userId: string, id: string, patch: { name?: unknown; lanIp?: unknown; mac?: unknown; scriptEnabled?: unknown }) {
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
  return { launcherToken: launcherToken as string, lanIp: row.lan_ip as string | null, mac: row.mac_address as string | null };
}

function checkArgs(kind: CommandKind, args: any, scriptEnabled: boolean): Record<string, unknown> {
  const a = args && typeof args === 'object' ? args : {};
  switch (kind) {
    case 'sunshine-pin': {
      if (!/^\d{4}$/.test(String(a.pin))) throw new MachineRequestError(400, 'The pairing PIN is 4 digits.');
      return { pin: String(a.pin), name: String(a.name || 'GGGH').replace(/[^\w .-]/g, '').slice(0, 30) || 'GGGH' };
    }
    case 'display-set': {
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
export async function agentPoll(token: string, report: any, holdMs = POLL_HOLD_MS, stepMs = 1500) {
  const m = await byToken(token, 'agent_token_hash');
  if (!m) return null;
  const st = report && typeof report === 'object' ? report : {};
  const safe = JSON.stringify(st).length <= 20_000 ? st : {};
  await query(
    `UPDATE local_machines SET last_seen_at = NOW(), status = $2,
       lan_ip = COALESCE($3, lan_ip), mac_address = COALESCE($4, mac_address) WHERE id = $1`,
    [m.id, JSON.stringify(safe), cleanIp(st.lanIp), normalizeMac(st.mac)],
  );
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
      return { commands: rows.map((r) => ({ id: r.id as string, kind: r.kind as string, args: r.args })), pollSeconds: 1 };
    }
    if (Date.now() >= until) return { commands: [], pollSeconds: 1 };
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
export async function launcherScreen(token: string, action: 'set' | 'restore', args: { width?: unknown; height?: unknown; fps?: unknown }, waitMs = 25_000) {
  const m = await byToken(token, 'launcher_token_hash');
  if (!m) return null;
  const online = !!m.last_seen_at && Date.now() - new Date(m.last_seen_at).getTime() < ONLINE_WITHIN_MS;
  if (!online) return { online: false, ok: false, message: 'The PC\'s agent isn\'t connected to GGGH, so its screen was left as it is.' };
  const kind: CommandKind = action === 'set' ? 'display-set' : 'display-restore';
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
