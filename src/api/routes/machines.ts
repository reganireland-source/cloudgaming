/**
 * ============================================================================
 * src/api/routes/machines.ts — CREATE AND CONTROL GAMING MACHINES
 * ============================================================================
 *
 * A "machine" is a cloud virtual machine (VM) with a GPU that runs your
 * games; you stream its screen to your own device. This file is the HTTP
 * front for everything you can do to one.
 *
 * Mounted at /api/machines (login required):
 *   GET    /api/machines                list my machines
 *   GET    /api/machines/:id            one machine's details
 *   POST   /api/machines                launch a new machine
 *   POST   /api/machines/:id/start      power on a stopped machine
 *   POST   /api/machines/:id/stop       power off (optionally snapshot first)
 *   POST   /api/machines/:id/migrate    move to another region/cloud
 *   POST   /api/machines/:id/quality    change streaming quality
 *   DELETE /api/machines/:id            destroy it permanently
 *
 * The real cloud work (calling AWS etc.) happens in
 * src/services/MachineService.ts. This file validates input, checks
 * permissions, calls the service, and turns the result into an HTTP reply.
 *
 * THE OWNERSHIP CHECK (repeated in most handlers below)
 * -----------------------------------------------------
 * Being logged in isn't enough: you must only control YOUR machines.
 * So before acting on machine :id, each handler:
 *   1. makes sure we know who the user is (else 401 Unauthorized),
 *   2. loads that machine's owner (404 if the machine doesn't exist),
 *   3. compares owner to the logged-in user (403 Forbidden if different).
 * 401 = "we don't know who you are"; 403 = "we know who you are, and the
 * answer is no".
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { query } from '../../config/database';
import { MachineService } from '../../services/MachineService';

const router = Router();

/**
 * GET /api/machines
 * All machines belonging to the logged-in user, newest first.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.userId; // set by authMiddleware

    // Filtering by user_id in the SQL means users can never see each
    // other's machines here.
    const result = await query(
      `SELECT id, provider, region, instance_type, status, cost_per_hour, created_at, last_started
       FROM machines
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('List machines error:', error);
    res.status(500).json({ error: 'Failed to fetch machines' });
  }
});

/**
 * GET /api/machines/:id
 * One machine. Matching on BOTH id and user_id doubles as the ownership
 * check: someone else's machine simply "isn't found".
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params; // the :id part of the URL
    const userId = req.userId;

    const result = await query(
      `SELECT * FROM machines WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get machine error:', error);
    res.status(500).json({ error: 'Failed to fetch machine' });
  }
});

/**
 * POST /api/machines
 * Launch a brand-new gaming machine.
 * Body: { provider, region, instanceType, gameTitle, quality? }
 *   e.g. { "provider": "aws", "region": "ap-southeast-1",
 *          "instanceType": "g4dn.xlarge", "gameTitle": "Elden Ring",
 *          "quality": "high" }
 * Replies 201 ("Created") with the new machine record.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { provider, region, instanceType, gameTitle, quality } = req.body;

    // TypeScript sees req.userId as "string OR undefined". This check both
    // protects us at runtime and proves to the compiler that, below this
    // line, userId is definitely a string.
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!provider || !region || !instanceType || !gameTitle) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Only allow games we have a profile for (the profile says how powerful
    // a machine the game needs). ILIKE = case-insensitive match, so
    // "elden ring" finds "Elden Ring".
    const gameResult = await query(
      'SELECT * FROM game_profiles WHERE title ILIKE $1',
      [gameTitle]
    );

    if (gameResult.rows.length === 0) {
      return res.status(400).json({ error: 'Game not found in library' });
    }

    // Hand over to the service: this is the slow part that talks to the
    // cloud provider and starts the automated setup.
    const machine = await MachineService.launchMachine(
      userId,
      provider,
      region,
      instanceType,
      gameTitle,
      quality || 'Good' // default quality if none chosen (the service lower-cases it)
    );

    res.status(201).json(machine);
  } catch (error) {
    console.error('Launch machine error:', error);
    res.status(500).json({ error: 'Failed to launch machine', details: String(error) });
  }
});

/**
 * POST /api/machines/:id/start
 * Power on a stopped machine. (Stopped machines don't cost compute money;
 * you still pay for their disk.)
 */
router.post('/:id/start', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Ownership check (see the explanation at the top of this file).
    const machineResult = await query(
      'SELECT user_id FROM machines WHERE id = $1',
      [id]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    if (machineResult.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await MachineService.startMachine(id, userId);

    // We reply "starting" rather than "running": the cloud takes a minute or
    // two to actually boot the machine.
    res.json({ status: 'starting' });
  } catch (error) {
    console.error('Start machine error:', error);
    res.status(500).json({ error: 'Failed to start machine', details: String(error) });
  }
});

/**
 * POST /api/machines/:id/stop
 * Power off a machine. By default a SNAPSHOT (backup of the disk) is taken
 * first so installed games are preserved. Send { "snapshot": false } to
 * skip it.
 */
router.post('/:id/stop', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const { snapshot } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Ownership check.
    const machineResult = await query(
      'SELECT user_id FROM machines WHERE id = $1',
      [id]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    if (machineResult.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // `snapshot !== false` is true unless the caller explicitly sent false,
    // so a missing value means "yes, take a snapshot" (the safe default).
    await MachineService.stopMachine(id, userId, snapshot !== false);

    res.json({ status: 'stopping' });
  } catch (error) {
    console.error('Stop machine error:', error);
    res.status(500).json({ error: 'Failed to stop machine', details: String(error) });
  }
});

/**
 * POST /api/machines/:id/migrate
 * Move a machine to a different region and/or cloud provider — e.g. to a
 * cheaper region, or one closer to where you're playing from.
 * Body: { "targetProvider": "aws", "targetRegion": "ap-northeast-1" }
 */
router.post('/:id/migrate', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const { targetProvider, targetRegion } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!targetProvider || !targetRegion) {
      return res.status(400).json({ error: 'Missing target provider or region' });
    }

    // Ownership check.
    const machineResult = await query(
      'SELECT user_id FROM machines WHERE id = $1',
      [id]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    if (machineResult.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Migration = snapshot the disk, restore it in the new location as a new
    // machine, then remove the old one. The service returns the NEW machine.
    const newMachine = await MachineService.migrateMachine(
      id,
      userId,
      targetProvider,
      targetRegion
    );

    res.json({ status: 'migrating', newMachine });
  } catch (error) {
    console.error('Migrate machine error:', error);
    res.status(500).json({ error: 'Failed to migrate machine', details: String(error) });
  }
});

/**
 * POST /api/machines/:id/quality
 * Change the streaming quality preset.
 * Body: { "quality": "budget" | "good" | "high" | "ultra" }
 * Higher quality = sharper picture but more data sent = higher egress cost.
 */
router.post('/:id/quality', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const { quality } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!quality) {
      return res.status(400).json({ error: 'Quality parameter is required' });
    }

    // Ownership check.
    const machineResult = await query(
      'SELECT user_id FROM machines WHERE id = $1',
      [id]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    if (machineResult.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // The service validates the quality name, saves it, and (if the machine
    // is running) pushes the new settings to the streaming software.
    const updatedMachine = await MachineService.updateStreamingQuality(id, userId, quality);

    res.json({
      status: 'quality_updated',
      machine: updatedMachine,
      message: `Streaming quality updated to ${quality}`, // `${...}` inserts a value into the text
    });
  } catch (error: any) {
    console.error('Update quality error:', error);
    res
      .status(500)
      .json({ error: 'Failed to update streaming quality', details: String(error) });
  }
});

/**
 * DELETE /api/machines/:id
 * Destroy the machine at the cloud provider ("terminate") and delete our
 * records of it and its snapshots. This cannot be undone.
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Ownership check.
    const machineResult = await query(
      'SELECT user_id FROM machines WHERE id = $1',
      [id]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    if (machineResult.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await MachineService.deleteMachine(id, userId);

    res.json({ status: 'terminated' });
  } catch (error) {
    console.error('Delete machine error:', error);
    res.status(500).json({ error: 'Failed to delete machine', details: String(error) });
  }
});

export default router;
