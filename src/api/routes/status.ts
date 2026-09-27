import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getSystemStatus } from '../../services/StatusService';
import { env } from '../../config/env';

const router = Router();

const startedAt = new Date();

// Read at runtime rather than `import packageJson from '../../../package.json'`
// - tsconfig's rootDir is ./src, and package.json lives outside it, so a
// static import would fail the build (TS6059).
function readAppVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '../../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * GET /api/status
 * Public, unauthenticated status of the backend itself, the database, and
 * network reachability to each major cloud provider's API - independent of
 * whether any user currently has a machine running there.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const status = await getSystemStatus(forceRefresh);
    res.json(status);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to compute system status' });
  }
});

/**
 * GET /api/version
 * Verbose build/version info for the running backend instance. Reads
 * whichever CI platform's git env vars are present (Railway, Vercel,
 * generic) so this stays accurate without a separate build step.
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
    nodeVersion: process.version,
    gitCommit: gitCommit ? gitCommit.slice(0, 12) : null,
    gitBranch,
    railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
    railwayEnvironment: process.env.RAILWAY_ENVIRONMENT_NAME || null,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

export default router;
