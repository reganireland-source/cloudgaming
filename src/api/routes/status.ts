/**
 * ============================================================================
 * src/api/routes/status.ts — POWERS THE STATUS LIGHTS AND "BUILD INFO"
 * ============================================================================
 *
 * Mounted at /api/status in src/index.ts, WITHOUT the login check — the
 * status bar at the top of every page needs to work before anyone logs in.
 *
 *   GET /api/status          which services are reachable (the six lights)
 *   GET /api/status/version  details about the running backend build
 *
 * Consumed by frontend/components/SystemStatusBar.tsx and BuildInfoPanel.tsx.
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import pool, { query } from '../../config/database';
import { getSystemStatus, getHistory, summarise, PROVIDER_PROBES } from '../../services/StatusService';
import { getMetrics } from '../../services/Metrics';
import { env } from '../../config/env';

const router = Router();

// Captured ONCE, when this file is first loaded (i.e. when the server boots).
// Lets /version report when this instance started.
const startedAt = new Date();

/**
 * Read the app version (e.g. "0.1.0") from package.json.
 *
 * Why not simply `import packageJson from '../../../package.json'`?
 * The TypeScript config (tsconfig.json) says all source lives under src/
 * ("rootDir"). package.json is outside src/, so a static import makes the
 * build fail. Reading the file at runtime sidesteps that.
 *
 * Path maths: compiled, this file runs from dist/api/routes/. Going up three
 * folders (../../../) reaches the project root, where package.json lives.
 */
function readAppVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '../../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); // text -> JavaScript object
    return pkg.version || 'unknown';
  } catch {
    // If the file can't be read for any reason, degrade gracefully instead
    // of crashing the whole endpoint.
    return 'unknown';
  }
}

/**
 * GET /api/status
 * Reports: is the backend up, can it reach the database, and can it reach
 * AWS / Azure / GCP / Oracle over the network? The cloud checks don't need
 * any user's credentials and don't care whether a machine is running —
 * they just test the network path. The heavy lifting (and a 15-second cache
 * so four cloud endpoints aren't hit on every page load) lives in
 * src/services/StatusService.ts.
 *
 * Add `?refresh=true` to the URL to bypass the cache and re-check now.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    // Query-string values are always text, so compare with the string 'true'.
    const forceRefresh = req.query.refresh === 'true';
    const status = await getSystemStatus(forceRefresh);
    res.json(status);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to compute system status' });
  }
});

/**
 * GET /api/status/version
 * Detailed information about the running backend, shown in the frontend's
 * "Build info" panel. Handy for confirming WHICH commit is actually deployed.
 *
 * Hosting platforms inject git details as environment variables
 * (Railway: RAILWAY_GIT_COMMIT_SHA, Vercel: VERCEL_GIT_COMMIT_SHA). We try
 * each in turn with `||` and fall back to null, so it works wherever it runs.
 */
router.get('/version', (req: Request, res: Response) => {
  const gitCommit =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    null;

  const gitBranch =
    process.env.RAILWAY_GIT_BRANCH ||
    process.env.VERCEL_GIT_COMMIT_REF ||
    process.env.GIT_BRANCH ||
    null;

  res.json({
    service: 'cloudgaming-hub-backend',
    version: readAppVersion(),
    environment: env.NODE_ENV,
    nodeVersion: process.version,                               // the Node.js version, e.g. "v22.1.0"
    gitCommit: gitCommit ? gitCommit.slice(0, 12) : null,       // first 12 chars of the commit hash is plenty to identify it
    gitBranch,
    railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
    railwayEnvironment: process.env.RAILWAY_ENVIRONMENT_NAME || null,
    startedAt: startedAt.toISOString(),                         // ISO format, e.g. "2026-09-27T06:07:34.777Z"
    uptimeSeconds: Math.floor(process.uptime()),                // seconds since the process started, rounded down
  });
});

/**
 * GET /api/status/details — the numbers behind each status light.
 *
 * Opened when you click a light in the status bar. PUBLIC like the lights
 * themselves, so it only returns aggregate, non-personal information:
 * uptime, memory, request counts, database size and version, latency
 * history and success rates. No user data, no secrets, no row contents.
 *
 * Each section is computed independently, so one failure (e.g. the
 * database being down) doesn't hide the others.
 */
router.get('/details', async (_req: Request, res: Response) => {
  // Refresh the lights first, so the history includes a check from right now.
  const status = await getSystemStatus(false).catch(() => null);

  // ---- Backend (this Node.js process on Railway) ----
  const mem = process.memoryUsage();
  const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;
  const backend = {
    uptimeSeconds: Math.floor(process.uptime()),
    startedAt: startedAt.toISOString(),
    nodeVersion: process.version,
    environment: env.NODE_ENV,
    gitCommit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 12) || null,
    railwayRegion: process.env.RAILWAY_REPLICA_REGION || process.env.RAILWAY_REGION || null,
    memoryMb: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal) },
    cpuCores: os.cpus().length,
    loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100), // 1, 5, 15-minute averages
    requests: getMetrics(),
  };

  // ---- Database (Postgres on Railway) ----
  let database: Record<string, unknown> = {};
  try {
    const t0 = Date.now();
    const [version, size, conns, tables, migrations] = await Promise.all([
      query('SELECT version() AS v'),
      query('SELECT pg_database_size(current_database()) AS bytes'),
      query(`SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`),
      query(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`),
      query(`SELECT COUNT(*)::int AS n, MAX(name) AS latest, MAX(applied_at) AS latest_at FROM schema_migrations`),
    ]);
    database = {
      connected: true,
      queryMs: Date.now() - t0,
      version: String(version.rows[0].v).split(' ').slice(0, 2).join(' '), // e.g. "PostgreSQL 16.4"
      sizeMb: mb(Number(size.rows[0].bytes)),
      activeConnections: conns.rows[0].n,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      tables: tables.rows[0].n,
      migrationsApplied: migrations.rows[0].n,
      latestMigration: migrations.rows[0].latest,
      latestMigrationAt: migrations.rows[0].latest_at,
    };
  } catch (error: any) {
    database = { connected: false, error: error.message || String(error) };
  }
  const dbHistory = getHistory('database');
  database.history = dbHistory;
  database.summary = summarise(dbHistory);

  // ---- Cloud APIs ----
  const providers = Object.fromEntries(
    (Object.keys(PROVIDER_PROBES) as Array<keyof typeof PROVIDER_PROBES>).map((name) => {
      const points = getHistory(name);
      const latest = status?.providers[name];
      return [name, {
        probeUrl: PROVIDER_PROBES[name],
        connected: latest?.connected ?? null,
        latencyMs: latest?.latencyMs ?? null,
        httpStatus: latest?.httpStatus ?? null,
        remoteAddress: latest?.remoteAddress ?? null,
        detail: latest?.detail ?? null,
        checkedAt: latest?.checkedAt ?? null,
        history: points,
        summary: summarise(points),
      }];
    })
  );

  res.json({ generatedAt: new Date().toISOString(), backend, database, providers });
});

export default router;
