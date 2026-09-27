import { Router, Request, Response } from 'express';
import { query } from '../../config/database';
import { MachineService } from '../../services/MachineService';

const router = Router();

/**
 * GET /api/machines
 * List all machines for the current user
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

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
 * Get a specific machine
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
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
 * Launch a new machine
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { provider, region, instanceType, gameTitle, quality } = req.body;

    if (!provider || !region || !instanceType || !gameTitle) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate game profile exists
    const gameResult = await query(
      'SELECT * FROM game_profiles WHERE title ILIKE $1',
      [gameTitle]
    );

    if (gameResult.rows.length === 0) {
      return res.status(400).json({ error: 'Game not found in library' });
    }

    // Launch machine
    const machine = await MachineService.launchMachine(
      userId,
      provider,
      region,
      instanceType,
      gameTitle,
      quality || 'Good'
    );

    res.status(201).json(machine);
  } catch (error) {
    console.error('Launch machine error:', error);
    res.status(500).json({ error: 'Failed to launch machine', details: String(error) });
  }
});

/**
 * POST /api/machines/:id/start
 * Start a machine
 */
router.post('/:id/start', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    // Verify ownership
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

    res.json({ status: 'starting' });
  } catch (error) {
    console.error('Start machine error:', error);
    res.status(500).json({ error: 'Failed to start machine', details: String(error) });
  }
});

/**
 * POST /api/machines/:id/stop
 * Stop a machine (with optional snapshot)
 */
router.post('/:id/stop', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const { snapshot } = req.body;

    // Verify ownership
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

    await MachineService.stopMachine(id, userId, snapshot !== false);

    res.json({ status: 'stopping' });
  } catch (error) {
    console.error('Stop machine error:', error);
    res.status(500).json({ error: 'Failed to stop machine', details: String(error) });
  }
});

/**
 * POST /api/machines/:id/migrate
 * Migrate a machine to a different region/provider
 */
router.post('/:id/migrate', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const { targetProvider, targetRegion } = req.body;

    if (!targetProvider || !targetRegion) {
      return res.status(400).json({ error: 'Missing target provider or region' });
    }

    // Verify ownership
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
 * Update streaming quality for a machine
 */
router.post('/:id/quality', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const { quality } = req.body;

    if (!quality) {
      return res.status(400).json({ error: 'Quality parameter is required' });
    }

    // Verify ownership
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

    const updatedMachine = await MachineService.updateStreamingQuality(id, userId, quality);

    res.json({
      status: 'quality_updated',
      machine: updatedMachine,
      message: `Streaming quality updated to ${quality}`,
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
 * Delete/terminate a machine
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    // Verify ownership
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
