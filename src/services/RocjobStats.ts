/**
 * ============================================================================
 * src/services/RocjobStats.ts: ANONYMOUS PLAY STATS FOR THE ROCJOB GAME
 * ============================================================================
 *
 * The game sends four kinds of event (install / launch / heartbeat / end) with
 * a random install id, a random per-launch session id, its build, version,
 * platform and (heartbeat/end) the playtime so far. Nothing else is accepted
 * and nothing identifying is stored: no IP address, user agent, hardware id,
 * name or email. The server stamps the time itself.
 *
 * Rate limiting keeps a visitor's address only in memory, only for a minute,
 * and never writes it to the database or the logs.
 *
 * Settings (environment variables on the backend; without them the feature
 * stays switched off):
 *   ROCJOB_INGEST_KEY    the shared key the game sends (public in the game, so spam protection only)
 *   ROCJOB_STATS_TOKEN   the secret that opens the private stats page / API
 *   ROCJOB_MAX_NEW_INSTALLS_PER_DAY   safety net against junk (default 200): once that many NEW installs
 *                        have appeared in 24 h, further new ones are answered 429 (the game retries later);
 *                        installs already known keep working
 * ============================================================================
 */

import crypto from 'crypto';
import { query } from '../config/database';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION = /^[A-Za-z0-9_-]{6,64}$/;
const VERSION = /^[0-9A-Za-z._-]{1,16}$/;
const EVENTS = ['install', 'launch', 'heartbeat', 'end'] as const;
const PLATFORMS = ['mac', 'windows', 'linux'] as const;
const MAX_SECONDS = 7 * 24 * 3600; // a week in one launch is not a real session

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
/** Constant-time comparison of two secrets. */
export function sameSecret(given: unknown, expected: string | undefined): boolean {
  if (!expected || typeof given !== 'string' || !given) return false;
  return crypto.timingSafeEqual(sha(given), sha(expected));
}

export const ingestEnabled = () => !!process.env.ROCJOB_INGEST_KEY;
export const statsEnabled = () => !!process.env.ROCJOB_STATS_TOKEN;
export const ingestKeyOk = (k: unknown) => sameSecret(k, process.env.ROCJOB_INGEST_KEY);
export const statsTokenOk = (t: unknown) => sameSecret(t, process.env.ROCJOB_STATS_TOKEN);

// ---------------------------------------------------------------------------
// In-memory, short-lived rate limits (never stored, never logged)
// ---------------------------------------------------------------------------

const windows = new Map<string, { n: number; reset: number }>();
/** true = allowed. `limit` hits per `ms`, keyed by any string (an address, an install id). */
export function allow(key: string, limit: number, ms: number): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || w.reset <= now) { windows.set(key, { n: 1, reset: now + ms }); return true; }
  w.n += 1;
  return w.n <= limit;
}
setInterval(() => { const now = Date.now(); for (const [k, w] of windows) if (w.reset <= now) windows.delete(k); }, 5 * 60_000).unref();

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export interface RocjobEvent { event: typeof EVENTS[number]; install: string; session: string; build: number; version: string; platform: typeof PLATFORMS[number]; seconds: number }

/** The event if it is exactly the contract, else null. Unknown fields are ignored (and never stored). */
export function parseEvent(b: any): RocjobEvent | null {
  if (!b || typeof b !== 'object' || b.v !== 1) return null;
  if (!EVENTS.includes(b.event)) return null;
  if (typeof b.install !== 'string' || !UUID.test(b.install)) return null;
  if (!PLATFORMS.includes(b.platform)) return null;
  if (!Number.isInteger(b.build) || b.build < 0 || b.build > 1_000_000) return null;
  if (typeof b.version !== 'string' || !VERSION.test(b.version)) return null;
  let session = '';
  if (b.event !== 'install') {
    if (typeof b.session !== 'string' || !SESSION.test(b.session)) return null;
    session = b.session;
  }
  let seconds = 0;
  if (b.event === 'heartbeat' || b.event === 'end') {
    if (!Number.isInteger(b.seconds) || b.seconds < 0 || b.seconds > MAX_SECONDS) return null;
    seconds = b.seconds;
  }
  return { event: b.event, install: b.install.toLowerCase(), session, build: b.build, version: b.version, platform: b.platform, seconds };
}

/** true = this event would create a brand-new install while the daily cap on new installs is used up. */
export async function newInstallCapped(install: string): Promise<boolean> {
  const cap = Math.max(1, Number(process.env.ROCJOB_MAX_NEW_INSTALLS_PER_DAY) || 200);
  const known = (await query('SELECT 1 FROM rocjob_installs WHERE install = $1', [install])).rows[0];
  if (known) return false;
  const n = Number((await query(`SELECT COUNT(*) AS n FROM rocjob_installs WHERE first_seen > NOW() - INTERVAL '24 hours'`)).rows[0].n);
  return n >= cap;
}

export async function recordEvent(e: RocjobEvent): Promise<void> {
  // The install row always exists (a lost "install" event must not lose the install); its first_seen never moves.
  await query(
    `INSERT INTO rocjob_installs (install, platform, build, version) VALUES ($1, $2, $3, $4)
     ON CONFLICT (install) DO UPDATE SET last_seen = NOW(), platform = EXCLUDED.platform, build = EXCLUDED.build, version = EXCLUDED.version`,
    [e.install, e.platform, e.build, e.version],
  );
  if (e.event === 'install') return;
  // Heartbeats and ends keep the MAX seconds for the session, so retries and crashes never double count.
  await query(
    `INSERT INTO rocjob_sessions (session, install, platform, build, version, seconds) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (session) DO UPDATE SET seconds = GREATEST(rocjob_sessions.seconds, EXCLUDED.seconds), last_event = NOW()
     WHERE rocjob_sessions.install = EXCLUDED.install`,
    [e.session, e.install, e.platform, e.build, e.version, e.seconds],
  );
}

// ---------------------------------------------------------------------------
// The private stats page's data
// ---------------------------------------------------------------------------

const TZ = 'Asia/Singapore'; // the designer's days

export async function stats() {
  const one = async (sql: string) => (await query(sql)).rows[0];
  const t = await one(`SELECT
      (SELECT COUNT(*) FROM rocjob_installs)::int AS installs,
      (SELECT COUNT(*) FROM rocjob_sessions)::int AS launches,
      (SELECT COALESCE(SUM(seconds), 0) FROM rocjob_sessions)::bigint AS play_seconds,
      (SELECT COUNT(*) FROM rocjob_sessions WHERE seconds > 0)::int AS played_sessions,
      (SELECT COUNT(DISTINCT install) FROM rocjob_sessions WHERE last_event > NOW() - INTERVAL '1 day')::int AS a1,
      (SELECT COUNT(DISTINCT install) FROM rocjob_sessions WHERE last_event > NOW() - INTERVAL '7 days')::int AS a7,
      (SELECT COUNT(DISTINCT install) FROM rocjob_sessions WHERE last_event > NOW() - INTERVAL '30 days')::int AS a30,
      GREATEST((SELECT MAX(last_event) FROM rocjob_sessions), (SELECT MAX(last_seen) FROM rocjob_installs)) AS last_event`);
  const daily = (await query(
    `WITH days AS (SELECT generate_series((NOW() AT TIME ZONE '${TZ}')::date - 29, (NOW() AT TIME ZONE '${TZ}')::date, '1 day')::date AS day)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
       (SELECT COUNT(*) FROM rocjob_installs i WHERE (i.first_seen AT TIME ZONE '${TZ}')::date = d.day)::int AS installs,
       (SELECT COUNT(*) FROM rocjob_sessions s WHERE (s.started AT TIME ZONE '${TZ}')::date = d.day)::int AS launches,
       (SELECT COALESCE(SUM(s.seconds), 0) FROM rocjob_sessions s WHERE (s.started AT TIME ZONE '${TZ}')::date = d.day)::int AS seconds
     FROM days d ORDER BY d.day`,
  )).rows;
  const builds = (await query(
    `SELECT build, MAX(version) AS version, COUNT(DISTINCT install)::int AS installs, COUNT(*) FILTER (WHERE launch)::int AS launches FROM (
       SELECT build, version, install, TRUE AS launch FROM rocjob_sessions
       UNION ALL SELECT build, version, install, FALSE FROM rocjob_installs) x
     GROUP BY build ORDER BY build DESC LIMIT 40`,
  )).rows;
  const platforms = (await query(`SELECT platform, COUNT(*)::int AS installs FROM rocjob_installs GROUP BY platform ORDER BY installs DESC`)).rows;
  const play = Number(t.play_seconds);
  return {
    now: new Date().toISOString(),
    lastEventAt: t.last_event ? new Date(t.last_event).toISOString() : null,
    totals: {
      installs: t.installs, launches: t.launches, playSeconds: play,
      avgSessionSeconds: t.played_sessions ? Math.round(play / t.played_sessions) : 0,
      avgPerInstallSeconds: t.installs ? Math.round(play / t.installs) : 0,
      active24h: t.a1, active7d: t.a7, active30d: t.a30,
    },
    daily, builds, platforms, timezone: TZ,
  };
}

/** Deletes everything. */
export async function wipe(): Promise<void> {
  await query('TRUNCATE rocjob_sessions, rocjob_installs');
}
