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
import { getSystemStatus } from '../../services/StatusService';
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

export default router;
