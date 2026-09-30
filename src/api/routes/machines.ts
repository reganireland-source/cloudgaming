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
 *   POST   /api/machines/:id/shelve      snapshot, then delete machine + disk → 202 { operationId }
 *   POST   /api/machines/:id/restore     bring a shelved machine back → 202 { operationId }  body { region?, keepSnapshot? }
 *   POST   /api/machines/:id/auto-shelve shelve after N days stopped  body { days: 1|3|7|14|30|null }
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
import { getSpotInfo, ON_RECLAIM } from '../../services/SpotPriceService';

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
  game_title, spot, disk_size_gb, ip_address, last_error, created_at, last_started, last_synced_at, snapshot_id,
  shelved_at, stopped_at, auto_shelve_days, auto_stop_minutes, display_driver`;

/**
 * What a machine costs per month while you AREN'T playing, and what it would
 * cost shelved — so every card can show the trade-off in dollars.
 *   diskMonthly     the disk, billed while it exists (stopped included)
 *   shelfMonthly    the snapshot of a shelved machine (actual stored GB when
 *                   the cloud reports it)
 *   shelfEstimate   if you shelved it now: low = a fresh install (~30 GB of
 *                   data), high = a completely full disk
 */
function standingFor(m: any) {
  const c = CATALOGS[m.provider as keyof typeof CATALOGS];
  if (!c) return null;
  const diskGb = Number(m.disk_size_gb) || c.defaultDiskGb;
  const r = (n: number) => Math.round(n * 100) / 100;
  const storedGb = m.snap_stored_gb != null ? Number(m.snap_stored_gb) : null;
  return {
    diskGb,
    diskMonthly: r(diskGb * c.diskPerGbMonth),
    shelfMonthly: m.status === 'shelved' ? r((storedGb ?? diskGb) * c.snapshotPerGbMonth) : null,
    shelfExact: storedGb != null,
    storedGb,
    shelfEstimate: { low: r(Math.min(30, diskGb) * c.snapshotPerGbMonth), high: r(diskGb * c.snapshotPerGbMonth) },
    restoreAnyRegion: c.restoreAnyRegion,
  };
}

/** GET /api/machines — my machines, newest first. */
router.get('/', async (req: Request, res: Response) => {
  try {
    const cols = MACHINE_COLUMNS.split(',').map((c) => `m.${c.trim()}`).join(', ');
    const result = await query(
      `SELECT ${cols}, s.stored_gb AS snap_stored_gb FROM machines m LEFT JOIN snapshots s ON s.id = m.snapshot_id
       WHERE m.user_id = $1 ORDER BY m.created_at DESC`, [req.userId]);
    // DECIMAL columns come back as text from `pg`; convert for the frontend.
    res.json(result.rows.map(({ snap_stored_gb, ...m }: any) => ({ ...m, cost_per_hour: Number(m.cost_per_hour) || 0, standing: standingFor({ ...m, snap_stored_gb }) })));
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
    const providers = await Promise.all(Object.values(CATALOGS).map(async (c) => {
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
        spotOnReclaim: ON_RECLAIM[c.provider],   // what happens if the cloud takes a spot machine back
        defaultRegion: (cred?.metadata as any)?.region || c.defaultRegion,
        defaultDiskGb: c.defaultDiskGb,
        minDiskGb: c.minDiskGb,
        diskPerGbMonth: c.diskPerGbMonth,
        snapshotPerGbMonth: c.snapshotPerGbMonth,
        restoreAnyRegion: c.restoreAnyRegion,
        priceNote: c.priceNote,
        regions: c.regions,
        bigScreen: c.bigScreen,                  // experimental GRID driver option
        // Price every shape in every region up front, so the form updates
        // instantly. Spot prices are live where the cloud publishes them
        // (src/services/SpotPriceService.ts).
        shapes: await Promise.all(c.shapes.map(async (s) => ({
          ...s,
          prices: Object.fromEntries(await Promise.all(c.regions.map(async (r) => {
            const spot = c.supportsSpot && r.gpus.includes(s.gpuModel) ? await getSpotInfo(c.provider, r.id, s.id).catch(() => null) : null;
            return [r.id, {
              onDemand: spot?.source === 'live' && c.provider === 'azure' ? spot.onDemandPerHour : c.estimateHourly(s.id, r.id, false),
              spot: spot ? spot.spotPerHour : c.supportsSpot ? c.estimateHourly(s.id, r.id, true) : null,
              spotDiscountPct: spot?.discountPct ?? null,
              spotSource: spot?.source ?? null,            // 'live' | 'fixed' | 'estimate'
              spotInterruption: spot?.interruption ?? null, // AWS: how often it's reclaimed here
            }] as const;
          }))),
        }))),
      };
    }));
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
    const { provider, region, shapeId, gameTitle, quality, spot, diskSizeGb, autoStopMinutes, autoShelveDays, bigScreen } = req.body || {};
    if (!provider || !region || !shapeId) {
      return res.status(400).json({ error: 'Choose a cloud, a region and a machine size.', tip: 'All three are required to launch.' });
    }
    const started = await MachineService.launch(req.userId!, {
      provider, region, shapeId, gameTitle, quality, spot, diskSizeGb, autoStopMinutes, autoShelveDays,
      bigScreen: bigScreen === true, // experimental GRID driver (screens up to 4096×2160)
    });
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

// Rescue an unfinished setup: start the machine if it stopped (e.g. a
// reclaimed spot machine), restart it if its setup went quiet.
router.post('/:id/resume-setup', async (req: Request, res: Response) => {
  try {
    res.status(202).json(await MachineService.resumeSetup(req.userId!, req.params.id));
  } catch (error) {
    sendRouteError(res, error, 'Failed to resume the setup');
  }
});

router.post('/:id/stop', async (req: Request, res: Response) => {
  try {
    res.status(202).json(await MachineService.stop(req.userId!, req.params.id, req.body?.snapshot === true));
  } catch (error) {
    sendRouteError(res, error, 'Failed to stop the machine');
  }
});

router.post('/:id/shelve', async (req: Request, res: Response) => {
  try {
    res.status(202).json(await MachineService.shelve(req.userId!, req.params.id));
  } catch (error) {
    sendRouteError(res, error, 'Failed to shelve the machine');
  }
});

router.post('/:id/restore', async (req: Request, res: Response) => {
  try {
    const region = typeof req.body?.region === 'string' ? req.body.region : undefined;
    res.status(202).json(await MachineService.restore(req.userId!, req.params.id, { region, keepSnapshot: req.body?.keepSnapshot === true }));
  } catch (error) {
    sendRouteError(res, error, 'Failed to restore the machine');
  }
});

router.post('/:id/auto-shelve', async (req: Request, res: Response) => {
  try {
    res.json(await MachineService.setAutoShelve(req.userId!, req.params.id, req.body?.days));
  } catch (error) {
    sendRouteError(res, error, 'Failed to change auto-shelve');
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
