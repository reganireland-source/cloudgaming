/**
 * ============================================================================
 * src/api/routes/machines.ts — GAMING MACHINES (ALL CLOUDS)
 * ============================================================================
 *
 * Mounted at /api/machines behind authMiddleware, so every handler knows the
 * signed-in user (req.userId) and only ever sees THAT user's machines.
 *
 *   GET    /api/machines                 list my machines
 *   GET    /api/machines/options         what can be launched (clouds, regions, sizes, prices, games)
 *   GET    /api/machines/:id             one machine
 *   POST   /api/machines                 launch        → 202 { machineId, operationId }
 *   POST   /api/machines/:id/start       power on      → 202 { operationId }
 *   POST   /api/machines/:id/stop        power off     → 202 { operationId }   body { snapshot?: boolean }
 *   POST   /api/machines/:id/sync        re-read state → 202 { operationId }
 *   DELETE /api/machines/:id             destroy       → 202 { operationId } (or 200 if nothing at the cloud)
 *   GET    /api/machines/:id/connection  IP, Sunshine login, setup progress
 *   POST   /api/machines/:id/quality     change streaming preset  body { quality }
 *   POST   /api/machines/:id/pair        one-click Moonlight pairing → 202 { operationId, pin, host }
 *
 * "202 Accepted" means: the request is fine and work has STARTED. The
 * frontend follows its progress at GET /api/operations/:operationId
 * (see routes/operations.ts) and shows the live commentary.
 *
 * ERRORS all have the shape { error, code?, tip?, friendly? } where
 * `friendly` is a full plain-English error card (providers/errors.ts).
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { query } from '../../config/database';
import { MachineRequestError, MachineService } from '../../services/MachineService';
import { FriendlyCloudError } from '../../providers/errors';
import { CATALOGS } from '../../providers/registry';
import { listCredentialSummaries } from '../../services/CredentialService';

const router = Router();

/** Turn any error into the standard JSON error reply. */
export function sendRouteError(res: Response, error: unknown, fallback: string) {
  if (error instanceof MachineRequestError) {
    return res.status(error.status).json({ error: error.message, tip: error.tip });
  }
  if (error instanceof FriendlyCloudError) {
    const f = error.friendly;
    return res.status(422).json({ error: f.title, code: f.code, tip: f.fixes[0], friendly: f });
  }
  console.error(`${fallback}:`, error);
  return res.status(500).json({ error: fallback, code: 'SERVER_ERROR', tip: 'Something broke on our side. Try again; if it persists, check the DATABASE light.' });
}

// The columns the frontend needs. connection_secret is deliberately NOT listed.
const MACHINE_COLUMNS = `id, provider, region, instance_type, instance_id, status, cost_per_hour, streaming_quality,
  game_title, spot, disk_size_gb, ip_address, last_error, created_at, last_started, last_synced_at, snapshot_id`;

/** GET /api/machines — my machines, newest first. */
router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await query(`SELECT ${MACHINE_COLUMNS} FROM machines WHERE user_id = $1 ORDER BY created_at DESC`, [req.userId]);
    // DECIMAL columns come back as text from `pg`; convert for the frontend.
    res.json(result.rows.map((m: any) => ({ ...m, cost_per_hour: Number(m.cost_per_hour) || 0 })));
  } catch (error) {
    sendRouteError(res, error, 'Failed to load machines');
  }
});

/**
 * GET /api/machines/options — everything the launch form needs, including
 * which clouds this user has credentials for (and whether their last check
 * passed), so the form can explain what's missing.
 */
router.get('/options', async (req: Request, res: Response) => {
  try {
    const creds = await listCredentialSummaries(req.userId!);
    const games = await query('SELECT title, gpu_class, target_quality FROM game_profiles ORDER BY title');
    const providers = Object.values(CATALOGS).map((c) => {
      const cred = creds.find((x) => x.provider === c.provider);
      return {
        provider: c.provider,
        label: c.label,
        configured: !!cred,
        lastCheckOk: cred?.lastCheckOk ?? null,
        lastCheckSummary: cred?.lastCheckSummary ?? null,
        available: c.shapes.length > 0 && c.regions.length > 0,
        supportsSpot: c.supportsSpot,
        spotLabel: c.spotLabel,
        defaultRegion: (cred?.metadata as any)?.region || c.defaultRegion,
        defaultDiskGb: c.defaultDiskGb,
        minDiskGb: c.minDiskGb,
        diskPerGbMonth: c.diskPerGbMonth,
        priceNote: c.priceNote,
        regions: c.regions,
        // Price every shape in every region up front, so the form updates instantly.
        shapes: c.shapes.map((s) => ({
          ...s,
          prices: Object.fromEntries(c.regions.map((r) => [r.id, {
            onDemand: c.estimateHourly(s.id, r.id, false),
            spot: c.supportsSpot ? c.estimateHourly(s.id, r.id, true) : null,
          }])),
        })),
      };
    });
    res.json({ providers, games: games.rows, qualities: ['budget', 'good', 'high', 'ultra'] });
  } catch (error) {
    sendRouteError(res, error, 'Failed to load launch options');
  }
});

/** GET /api/machines/:id */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await query(`SELECT ${MACHINE_COLUMNS} FROM machines WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Machine not found.' });
    res.json({ ...result.rows[0], cost_per_hour: Number(result.rows[0].cost_per_hour) || 0 });
  } catch (error) {
    sendRouteError(res, error, 'Failed to load machine');
  }
});

/** POST /api/machines — body { provider, region, shapeId, gameTitle?, quality?, spot?, diskSizeGb? } */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { provider, region, shapeId, gameTitle, quality, spot, diskSizeGb, autoStopMinutes } = req.body || {};
    if (!provider || !region || !shapeId) {
      return res.status(400).json({ error: 'Choose a cloud, a region and a machine size.', tip: 'All three are required to launch.' });
    }
    const started = await MachineService.launch(req.userId!, { provider, region, shapeId, gameTitle, quality, spot, diskSizeGb, autoStopMinutes });
    res.status(202).json(started);
  } catch (error) {
    sendRouteError(res, error, 'Failed to start the launch');
  }
});

router.post('/:id/start', async (req: Request, res: Response) => {
  try {
    res.status(202).json(await MachineService.start(req.userId!, req.params.id));
  } catch (error) {
    sendRouteError(res, error, 'Failed to start the machine');
  }
});

router.post('/:id/stop', async (req: Request, res: Response) => {
  try {
    res.status(202).json(await MachineService.stop(req.userId!, req.params.id, req.body?.snapshot === true));
  } catch (error) {
    sendRouteError(res, error, 'Failed to stop the machine');
  }
});

router.post('/:id/sync', async (req: Request, res: Response) => {
  try {
    res.status(202).json(await MachineService.sync(req.userId!, req.params.id));
  } catch (error) {
    sendRouteError(res, error, 'Failed to refresh the machine');
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await MachineService.remove(req.userId!, req.params.id);
    res.status(result.operationId ? 202 : 200).json(result);
  } catch (error) {
    sendRouteError(res, error, 'Failed to delete the machine');
  }
});

router.get('/:id/connection', async (req: Request, res: Response) => {
  try {
    res.json(await MachineService.connection(req.userId!, req.params.id));
  } catch (error) {
    sendRouteError(res, error, 'Failed to load connection details');
  }
});

/** POST /api/machines/:id/pair — one-click Moonlight pairing (see MachineService.pair). */
router.post('/:id/pair', async (req: Request, res: Response) => {
  try {
    res.status(202).json(await MachineService.pair(req.userId!, req.params.id));
  } catch (error) {
    sendRouteError(res, error, 'Failed to start pairing');
  }
});

router.post('/:id/quality', async (req: Request, res: Response) => {
  try {
    const machine = await MachineService.updateQuality(req.userId!, req.params.id, req.body?.quality);
    res.json({ status: 'quality_updated', machine });
  } catch (error) {
    sendRouteError(res, error, 'Failed to update streaming quality');
  }
});

export default router;
