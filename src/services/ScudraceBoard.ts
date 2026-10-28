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
const HASH = /^[0-9A-Za-z_-]{8,64}$/;

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
    if (typeof b.replay_hash !== 'string' || !HASH.test(b.replay_hash)) return { ok: false, error: 'replay_hash must be 8 to 64 letters, digits, - or _.' };
    replayHash = b.replay_hash;
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
  return { rank: r.rank as number, best_for_install: best, total_entries: r.total as number };
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
    `SELECT initials, lap_ms, car, transmission, build, created_at FROM (
       SELECT DISTINCT ON (install) initials, lap_ms, car, transmission, build, created_at
       FROM scudrace_scores WHERE grp = $1 AND mode = $2 AND course = $3${extra}
       ORDER BY install, lap_ms, created_at) best
     ORDER BY lap_ms, created_at LIMIT $${args.length}`, args,
  )).rows;
  return rows.map((r, i) => ({ rank: i + 1, initials: String(r.initials), lap_ms: r.lap_ms as number, car: r.car as string, transmission: r.transmission as string, build: r.build as string, created_at: new Date(r.created_at).toISOString() }));
}

/** Owner only: removes a group's scores (optionally just one mode / course). */
export async function clear(grp: string, mode?: string, course?: string): Promise<number> {
  const args: unknown[] = [grp]; let extra = '';
  if (mode) { args.push(mode); extra += ` AND mode = $${args.length}`; }
  if (course) { args.push(course); extra += ` AND course = $${args.length}`; }
  return (await query(`DELETE FROM scudrace_scores WHERE grp = $1${extra}`, args)).rowCount || 0;
}
