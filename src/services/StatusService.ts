/**
 * ============================================================================
 * src/services/StatusService.ts — CHECKS BEHIND THE SIX STATUS LIGHTS
 * ============================================================================
 *
 * The status bar at the top of every page shows six lights:
 *   Backend, Database, AWS, Azure, GCP, Oracle.
 * This file works out whether each should be green (reachable) or red.
 *
 *   Backend  — if this code is running and answering, it's up (always green here;
 *              the FRONTEND turns it red when it can't reach us at all).
 *   Database — runs a tiny query and times it.
 *   Clouds   — sends a lightweight network request to each provider's public
 *              API address and times it. This checks the NETWORK PATH only:
 *              it needs no credentials, and it doesn't matter whether you
 *              have any machine on that cloud.
 *
 * Results are CACHED for 15 seconds. Every open browser tab polls this, and
 * we don't want each poll to fire four requests at four clouds.
 * ============================================================================
 */

// Node's built-in HTTPS client — used to send the probe requests.
import https from 'https';
import { query } from '../config/database';

/** The result for one light. */
export interface ServiceStatus {
  name: string;
  connected: boolean;       // green (true) or red (false)
  latencyMs?: number;       // how long the check took, in milliseconds
  detail?: string;          // why it failed, if it did
  httpStatus?: number;      // cloud probes: the HTTP status the API answered with
  remoteAddress?: string;   // cloud probes: the IP address we actually connected to
  checkedAt: string;        // when the check ran (ISO timestamp text)
}

/** The full answer returned by GET /api/status. */
export interface SystemStatus {
  backend: ServiceStatus;
  database: ServiceStatus;
  providers: {
    aws: ServiceStatus;
    azure: ServiceStatus;
    gcp: ServiceStatus;
    oracle: ServiceStatus;
  };
}

// The public address probed for each cloud. These are the providers' main
// API endpoints — always online, and they answer even without credentials
// (usually with an error like "unauthorised", which still proves we can
// reach them). `Record<'aws' | ..., string>` means: an object that MUST have
// exactly these four keys, each holding a string.
export const PROVIDER_PROBES: Record<'aws' | 'azure' | 'gcp' | 'oracle', string> = {
  aws: 'https://ec2.amazonaws.com',
  azure: 'https://management.azure.com',
  gcp: 'https://compute.googleapis.com',
  oracle: 'https://cloud.oracle.com',
};

const PROBE_TIMEOUT_MS = 4000;  // give up on a probe after 4 seconds
const CACHE_TTL_MS = 15000;     // reuse results for 15 seconds ("TTL" = time to live)

// The cache: the last result plus the moment it goes stale.
// `let` (not `const`) because we replace it after each fresh check.
// It lives in memory, so it resets when the server restarts.
let cache: { data: SystemStatus; expiresAt: number } | null = null;

/**
 * Send one quick request to a URL and report whether ANY reply came back.
 *
 * We use a HEAD request: like a normal GET, but the server sends only the
 * headers, no body — the cheapest possible "are you there?".
 *
 * Returns a Promise — a placeholder for a result that arrives later.
 * `new Promise((resolve) => ...)` lets us call `resolve(value)` once we
 * know the answer. This function never "rejects" (fails): every outcome,
 * good or bad, is resolved as a result object, so callers don't need
 * try/catch for normal network failures.
 */
function probeUrl(url: string): Promise<{ ok: boolean; latencyMs: number; detail?: string; httpStatus?: number; remoteAddress?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();

    // Fire the request. The callback runs when a response starts arriving.
    const req = https.request(url, { method: 'HEAD', timeout: PROBE_TIMEOUT_MS }, (res) => {
      // We don't care about the response body; res.resume() discards it so
      // the connection is released properly.
      res.resume();
      // Any HTTP reply at all — even 401/403/404 — proves the network path works.
      resolve({ ok: true, latencyMs: Date.now() - start, httpStatus: res.statusCode, remoteAddress: res.socket?.remoteAddress });
    });

    // No reply within PROBE_TIMEOUT_MS: abort the request and report down.
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, latencyMs: Date.now() - start, detail: 'timeout' });
    });

    // A connection-level failure: DNS couldn't find the host, the connection
    // was refused or reset, a TLS problem, etc. No HTTP reply ever arrived,
    // so this genuinely counts as unreachable.
    req.on('error', (err) => {
      resolve({ ok: false, latencyMs: Date.now() - start, detail: err.message });
    });

    // Actually send it. Until end() is called, the request is only prepared.
    req.end();
  });
}

/**
 * Database light: run "SELECT 1" (the smallest possible query) and time it.
 */
async function checkDatabase(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await query('SELECT 1');
    return {
      name: 'database',
      connected: true,
      latencyMs: Date.now() - start,
      checkedAt: new Date().toISOString(),
    };
  } catch (error: any) {
    return {
      name: 'database',
      connected: false,
      latencyMs: Date.now() - start,
      detail: error.message || String(error),
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * One cloud provider's light: probe its API address.
 */
async function checkProvider(
  name: 'aws' | 'azure' | 'gcp' | 'oracle'
): Promise<ServiceStatus> {
  const url = PROVIDER_PROBES[name];
  try {
    const result = await probeUrl(url);
    return {
      name,
      connected: result.ok,
      latencyMs: result.latencyMs,
      detail: result.detail,
      httpStatus: result.httpStatus,
      remoteAddress: result.remoteAddress,
      checkedAt: new Date().toISOString(),
    };
  } catch (error: any) {
    // probeUrl never rejects, but this guards against anything unexpected
    // (e.g. a malformed URL throwing synchronously).
    return {
      name,
      connected: false,
      detail: error.message || String(error),
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Build the full status report — the only function other files call.
 *
 * @param forceRefresh true to ignore the cache and check everything now
 */
export async function getSystemStatus(forceRefresh = false): Promise<SystemStatus> {
  // Serve the cached answer if we have one that hasn't expired yet.
  if (!forceRefresh && cache && cache.expiresAt > Date.now()) {
    return cache.data;
  }

  // Run all five checks AT THE SAME TIME rather than one after another.
  // Promise.all waits until every one has finished, and returns their
  // results in the same order as the list. So the whole thing takes as long
  // as the slowest check (at most ~4 s), not the sum of all of them.
  // The `[database, aws, ...] =` part unpacks the results into named variables.
  const [database, aws, azure, gcp, oracle] = await Promise.all([
    checkDatabase(),
    checkProvider('aws'),
    checkProvider('azure'),
    checkProvider('gcp'),
    checkProvider('oracle'),
  ]);

  const data: SystemStatus = {
    backend: {
      name: 'backend',
      connected: true, // we're answering, so we're up
      checkedAt: new Date().toISOString(),
    },
    database,
    providers: { aws, azure, gcp, oracle }, // shorthand for { aws: aws, azure: azure, ... }
  };

  // Remember this result for the next 15 seconds.
  cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  remember(database);
  for (const p of [aws, azure, gcp, oracle]) remember(p);
  return data;
}

// ---------------------------------------------------------------------------
// History: the last few results for each light, for the detail panels
// ---------------------------------------------------------------------------
// Kept in memory only (resets on restart). A fresh result is added each time
// the status is actually re-checked (at most every 15 s, and only while
// someone has the site open), so ~40 entries ≈ the last 10+ minutes.

export interface HistoryPoint {
  at: string;
  ok: boolean;
  latencyMs?: number;
  httpStatus?: number;
  detail?: string;
}

const HISTORY_LENGTH = 40;
const history: Record<string, HistoryPoint[]> = {};

function remember(status: ServiceStatus): void {
  const list = (history[status.name] ||= []);
  list.push({ at: status.checkedAt, ok: status.connected, latencyMs: status.latencyMs, httpStatus: status.httpStatus, detail: status.detail });
  if (list.length > HISTORY_LENGTH) list.shift();
}

/** The recorded history for one light ('database', 'aws', ...). */
export function getHistory(name: string): HistoryPoint[] {
  return history[name] ? [...history[name]] : [];
}

/** Summary numbers over a history: success rate and latency spread. */
export function summarise(points: HistoryPoint[]) {
  const latencies = points.filter((p) => p.ok && typeof p.latencyMs === 'number').map((p) => p.latencyMs as number);
  const sorted = [...latencies].sort((a, b) => a - b);
  const pick = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
  return {
    checks: points.length,
    successRate: points.length ? Math.round((points.filter((p) => p.ok).length / points.length) * 1000) / 10 : null,
    latencyMin: sorted.length ? sorted[0] : null,
    latencyMedian: pick(0.5),
    latencyP95: pick(0.95),
    latencyMax: sorted.length ? sorted[sorted.length - 1] : null,
    lastFailure: [...points].reverse().find((p) => !p.ok) || null,
  };
}
