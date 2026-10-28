/**
 * ============================================================================
 * src/services/ScudraceBoard.ts: LAP-TIME LEADERBOARD FOR THE SCUD RACE GAME
 * ============================================================================
 *
 * A small leaderboard for a hobby racing game and a few friends. No accounts:
 * a lap is sent with the game's random install id, a group code (the friends'
 * code), three-letter initials, and what was driven where. Nothing else about
 * a player is stored.
 *
 * A board is one (group, mode, course). Boards are fully separate per mode and
 * course. Each install shows once on a board, with its best lap.
 *
 * Settings (environment variables on the backend; without SCUDRACE_GROUPS the
 * service stays switched off):
 *   SCUDRACE_GROUPS         the group codes that may post and read, comma separated
 *   SCUDRACE_ADMIN_TOKEN    optional: lets the owner clear a group's scores
 * ============================================================================
 */

import crypto from 'crypto';
import { query } from '../config/database';

export const MODES = ['rebuilt', 'remaster', 'reimagined'] as const;
export const COURSES = ['beginner_day', 'beginner_night', 'medium', 'expert'] as const;
export const CARS = ['ferrari', 'mclaren', 'porsche', 'viper'] as const;
export const TRANSMISSIONS = ['auto', 'manual'] as const;
export const LAP_MIN_MS = 20_000;       // faster than this is not a real lap
export const LAP_MAX_MS = 600_000;      // ten minutes
export const TOTAL_MAX_MS = 3_600_000;
const KEEP_PER_COMBO = 5;               // best laps kept per install / mode / course / car / transmission
const DAILY_ROW_CAP = 5000;             // safety net per group

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROUP = /^[A-Za-z0-9_-]{3,32}$/;
const BUILD = /^[0-9A-Za-z._+-]{1,32}$/;
const HASH = /^(?:[0-9a-f]{16}|[0-9a-f]{64})$/i;   // 16 hex chars (or a full SHA-256, of which the first 16 are kept)

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
const same = (a: unknown, b: string | undefined) => !!b && typeof a === 'string' && !!a && crypto.timingSafeEqual(sha(a), sha(b));

/** The group codes this service accepts (lower-cased), from the environment. */
export const groups = (): string[] => String(process.env.SCUDRACE_GROUPS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
export const enabled = () => groups().length > 0;
export const knownGroup = (g: unknown): string | null => (typeof g === 'string' && GROUP.test(g) && groups().includes(g.toLowerCase()) ? g.toLowerCase() : null);
export const adminOk = (t: unknown) => same(t, process.env.SCUDRACE_ADMIN_TOKEN);

const windows = new Map<string, { n: number; reset: number }>();
export function allow(key: string, limit: number, ms: number): boolean {
  const now = Date.now(); const w = windows.get(key);
  if (!w || w.reset <= now) { windows.set(key, { n: 1, reset: now + ms }); return true; }
  w.n += 1; return w.n <= limit;
}
setInterval(() => { const now = Date.now(); for (const [k, w] of windows) if (w.reset <= now) windows.delete(k); }, 5 * 60_000).unref();

export interface Score { install: string; grp: string; initials: string; mode: string; course: string; car: string; transmission: string; lapMs: number; totalMs: number | null; build: string; replayHash: string | null }

/** The score if the body is exactly the contract, else a short reason. */
export function parseScore(b: any): { ok: true; score: Score } | { ok: false; error: string } {
  if (!b || typeof b !== 'object') return { ok: false, error: 'Send a JSON body.' };
  const grp = knownGroup(b.group);
  if (!grp) return { ok: false, error: 'Unknown group code.' };
  if (typeof b.install_id !== 'string' || !UUID.test(b.install_id)) return { ok: false, error: 'install_id must be a UUID.' };
  const initials = typeof b.initials === 'string' ? b.initials.toUpperCase() : '';
  if (!/^[A-Z0-9]{3}$/.test(initials)) return { ok: false, error: 'initials must be 3 characters, A-Z or 0-9.' };
  if (!MODES.includes(b.mode)) return { ok: false, error: `mode must be one of ${MODES.join(', ')}.` };
  if (!COURSES.includes(b.course)) return { ok: false, error: `course must be one of ${COURSES.join(', ')}.` };
  if (!CARS.includes(b.car)) return { ok: false, error: `car must be one of ${CARS.join(', ')}.` };
  if (!TRANSMISSIONS.includes(b.transmission)) return { ok: false, error: 'transmission must be auto or manual.' };
  if (!Number.isInteger(b.lap_ms) || b.lap_ms < LAP_MIN_MS || b.lap_ms > LAP_MAX_MS) return { ok: false, error: `lap_ms must be a whole number between ${LAP_MIN_MS} and ${LAP_MAX_MS}.` };
  let totalMs: number | null = null;
  if (b.total_ms !== undefined && b.total_ms !== null) {
    if (!Number.isInteger(b.total_ms) || b.total_ms < b.lap_ms || b.total_ms > TOTAL_MAX_MS) return { ok: false, error: 'total_ms must be a whole number, not less than lap_ms.' };
    totalMs = b.total_ms;
  }
  if (typeof b.build !== 'string' || !BUILD.test(b.build)) return { ok: false, error: 'build must be a short version string.' };
  let replayHash: string | null = null;
  if (b.replay_hash !== undefined && b.replay_hash !== null && b.replay_hash !== '') {
    if (typeof b.replay_hash !== 'string' || !HASH.test(b.replay_hash)) return { ok: false, error: 'replay_hash must be 16 hex characters (or 64: the first 16 are kept).' };
    replayHash = b.replay_hash.slice(0, 16).toLowerCase();
  }
  return { ok: true, score: { install: b.install_id.toLowerCase(), grp, initials, mode: b.mode, course: b.course, car: b.car, transmission: b.transmission, lapMs: b.lap_ms, totalMs, build: b.build, replayHash } };
}

/** true = this group has already had its daily limit of laps. */
export async function groupFull(grp: string): Promise<boolean> {
  const n = Number((await query(`SELECT COUNT(*) AS n FROM scudrace_scores WHERE grp = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [grp])).rows[0].n);
  return n >= DAILY_ROW_CAP;
}

/** Stores the lap (a repeat of the same lap is ignored), keeps only each install's best few per combination, and says where it stands. */
export async function submit(s: Score) {
  await query(
    `INSERT INTO scudrace_scores (install, grp, initials, mode, course, car, transmission, lap_ms, total_ms, build, replay_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [s.install, s.grp, s.initials, s.mode, s.course, s.car, s.transmission, s.lapMs, s.totalMs, s.build, s.replayHash],
  );
  // A resend of the same lap may bring the replay hash the first one lacked.
  if (s.replayHash) {
    await query(
      `UPDATE scudrace_scores SET replay_hash = $9 WHERE replay_hash IS NULL AND install = $1 AND grp = $2 AND mode = $3 AND course = $4 AND car = $5 AND transmission = $6 AND lap_ms = $7 AND total_ms IS NOT DISTINCT FROM $8`,
      [s.install, s.grp, s.mode, s.course, s.car, s.transmission, s.lapMs, s.totalMs, s.replayHash],
    );
  }
  await query(
    `DELETE FROM scudrace_scores WHERE id IN (
       SELECT id FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY lap_ms, created_at) AS rn FROM scudrace_scores
                       WHERE install = $1 AND grp = $2 AND mode = $3 AND course = $4 AND car = $5 AND transmission = $6) x WHERE rn > $7)`,
    [s.install, s.grp, s.mode, s.course, s.car, s.transmission, KEEP_PER_COMBO],
  );
  // The board: each install once, with its best lap on this group's mode and course (any car).
  const best = Number((await query(`SELECT MIN(lap_ms) AS b FROM scudrace_scores WHERE install = $1 AND grp = $2 AND mode = $3 AND course = $4`, [s.install, s.grp, s.mode, s.course])).rows[0].b);
  const r = (await query(
    `WITH b AS (SELECT install, MIN(lap_ms) AS best FROM scudrace_scores WHERE grp = $1 AND mode = $2 AND course = $3 GROUP BY install)
     SELECT (SELECT COUNT(*) FROM b WHERE best < $4)::int + 1 AS rank, (SELECT COUNT(*) FROM b)::int AS total`,
    [s.grp, s.mode, s.course, best],
  )).rows[0];
  // This lap's row (it may already have been pushed out if it is not among the install's best laps).
  const row = (await query(
    `SELECT s.id, s.replay_hash, (r.score_id IS NOT NULL) AS has_blob FROM scudrace_scores s LEFT JOIN scudrace_replays r ON r.score_id = s.id
     WHERE s.install = $1 AND s.grp = $2 AND s.mode = $3 AND s.course = $4 AND s.car = $5 AND s.transmission = $6 AND s.lap_ms = $7 AND s.total_ms IS NOT DISTINCT FROM $8`,
    [s.install, s.grp, s.mode, s.course, s.car, s.transmission, s.lapMs, s.totalMs],
  )).rows[0];
  return {
    rank: r.rank as number, best_for_install: best, total_entries: r.total as number,
    id: row ? Number(row.id) : null,
    replay_wanted: !!row && !!row.replay_hash && !row.has_blob,
  };
}

export interface BoardQuery { grp: string; mode: string; course: string; car?: string; transmission?: string; limit: number }

/** Sorted entries, each install once (its best lap within the filters). */
export async function board(q: BoardQuery) {
  const args: unknown[] = [q.grp, q.mode, q.course];
  let extra = '';
  if (q.car) { args.push(q.car); extra += ` AND car = $${args.length}`; }
  if (q.transmission) { args.push(q.transmission); extra += ` AND transmission = $${args.length}`; }
  args.push(q.limit);
  const rows = (await query(
    `SELECT id, initials, lap_ms, car, transmission, build, created_at, replay FROM (
       SELECT DISTINCT ON (s.install) s.id, s.initials, s.lap_ms, s.car, s.transmission, s.build, s.created_at, (r.score_id IS NOT NULL) AS replay
       FROM scudrace_scores s LEFT JOIN scudrace_replays r ON r.score_id = s.id
       WHERE s.grp = $1 AND s.mode = $2 AND s.course = $3${extra.replace(/ AND car/g, ' AND s.car').replace(/ AND transmission/g, ' AND s.transmission')}
       ORDER BY s.install, s.lap_ms, s.created_at) best
     ORDER BY lap_ms, created_at LIMIT $${args.length}`, args,
  )).rows;
  return rows.map((r, i) => ({ rank: i + 1, id: Number(r.id), replay: !!r.replay, initials: String(r.initials), lap_ms: r.lap_ms as number, car: r.car as string, transmission: r.transmission as string, build: r.build as string, created_at: new Date(r.created_at).toISOString() }));
}

/** Owner only: removes a group's scores (optionally just one mode / course). */
export async function clear(grp: string, mode?: string, course?: string): Promise<number> {
  const args: unknown[] = [grp]; let extra = '';
  if (mode) { args.push(mode); extra += ` AND mode = $${args.length}`; }
  if (course) { args.push(course); extra += ` AND course = $${args.length}`; }
  return (await query(`DELETE FROM scudrace_scores WHERE grp = $1${extra}`, args)).rowCount || 0;
}

// ---------------------------------------------------------------------------
// Replay (ghost) blobs: raw bytes, one per score row
// ---------------------------------------------------------------------------

export const REPLAY_TYPE = 'application/vnd.scudrace.replay';
export const REPLAY_MAX_BYTES = 16384;
const PER_INSTALL_BLOBS = 200;
const PER_GROUP_BYTES = 25 * 1024 * 1024;

let crcTable: Uint32Array | null = null;
/** CRC-32 (the usual zlib / PNG one). */
export function crc32(buf: Buffer): number {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The blob's own header: 'SRPL', version byte 1, and a little-endian CRC-32 of everything before the last 4 bytes. Nothing is inflated or simulated. */
export function blobLooksValid(b: Buffer): boolean {
  if (b.length < 9) return false;
  if (b[0] !== 0x53 || b[1] !== 0x52 || b[2] !== 0x50 || b[3] !== 0x4c || b[4] !== 1) return false;
  return crc32(b.subarray(0, b.length - 4)) === b.readUInt32LE(b.length - 4);
}

export const sha16 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

export type ReplayResult = { status: 200; body: { status: 'stored'; bytes: number } | { status: 'exists' } } | { status: 400 | 404 | 409; body: { error: string } };

/** Checks, in order: the row exists and belongs to this install (and group); the hash matches; the blob header is sound. */
export async function storeReplay(id: number, install: string, grp: string | null, body: Buffer | null): Promise<ReplayResult> {
  const row = (await query(`SELECT id, grp, replay_hash FROM scudrace_scores WHERE id = $1 AND install = $2`, [id, install])).rows[0];
  if (!row || (grp && row.grp !== grp) || !row.replay_hash) return { status: 404, body: { error: 'not_found' } };
  if (!body) return { status: 400, body: { error: 'bad_blob' } }; // not sent as raw bytes with the replay content type
  if (sha16(body) !== row.replay_hash) return { status: 409, body: { error: 'hash_mismatch' } };
  if (!blobLooksValid(body)) return { status: 400, body: { error: 'bad_blob' } };
  const ins = await query(`INSERT INTO scudrace_replays (score_id, data) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, body]);
  if (!ins.rowCount) return { status: 200, body: { status: 'exists' } };
  await trimReplays(row.grp, install);
  return { status: 200, body: { status: 'stored', bytes: body.length } };
}

/** Keeps blobs within the limits: 200 per install (oldest go first) and 25 MB per group (oldest outside the top 10 of their board go first). */
async function trimReplays(grp: string, install: string) {
  await query(
    `DELETE FROM scudrace_replays WHERE score_id IN (
       SELECT r.score_id FROM scudrace_replays r JOIN scudrace_scores s ON s.id = r.score_id WHERE s.install = $1
       ORDER BY r.created_at DESC OFFSET $2)`, [install, PER_INSTALL_BLOBS]);
  for (let i = 0; i < 50; i++) {
    const used = Number((await query(`SELECT COALESCE(SUM(OCTET_LENGTH(r.data)), 0) AS n FROM scudrace_replays r JOIN scudrace_scores s ON s.id = r.score_id WHERE s.grp = $1`, [grp])).rows[0].n);
    if (used <= PER_GROUP_BYTES) return;
    const gone = await query(
      `DELETE FROM scudrace_replays WHERE score_id = (
         SELECT x.id FROM (SELECT s.id, r.created_at, ROW_NUMBER() OVER (PARTITION BY s.mode, s.course ORDER BY s.lap_ms) AS pos
                           FROM scudrace_scores s JOIN scudrace_replays r ON r.score_id = s.id WHERE s.grp = $1) x
         WHERE x.pos > 10 ORDER BY x.created_at LIMIT 1)`, [grp]);
    if (!gone.rowCount) return; // everything left is in a top 10
  }
}

/** The stored bytes and hash for a score row in this group, or null. */
export async function getReplay(id: number, grp: string): Promise<{ data: Buffer; hash: string } | null> {
  const row = (await query(`SELECT r.data, s.replay_hash FROM scudrace_replays r JOIN scudrace_scores s ON s.id = r.score_id WHERE s.id = $1 AND s.grp = $2`, [id, grp])).rows[0];
  return row ? { data: row.data as Buffer, hash: String(row.replay_hash) } : null;
}
