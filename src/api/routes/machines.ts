import { Router, Request, Response } from 'express';
import { query } from '../../config/database';

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

    if (!provider || !region || !instanceType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // TODO: Validate game profile and quality
    // TODO: Call cloud provider to launch instance
    // TODO: Insert machine record

    res.status(501).json({ error: 'Not yet implemented' });
  } catch (error) {
    console.error('Launch machine error:', error);
    res.status(500).json({ error: 'Failed to launch machine' });
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

    // TODO: Verify ownership
    // TODO: Call cloud provider to start instance
    // TODO: Update status in DB

    res.status(501).json({ error: 'Not yet implemented' });
  } catch (error) {
    console.error('Start machine error:', error);
    res.status(500).json({ error: 'Failed to start machine' });
  }
});

/**
 * POST /api/machines/:id/stop
 * Stop a machine
 */
router.post('/:id/stop', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    // TODO: Verify ownership
    // TODO: Create snapshot if requested
    // TODO: Call cloud provider to stop instance
    // TODO: Update status in DB

    res.status(501).json({ error: 'Not yet implemented' });
  } catch (error) {
    console.error('Stop machine error:', error);
    res.status(500).json({ error: 'Failed to stop machine' });
  }
});

/**
 * POST /api/machines/:id/migrate
 * Migrate a machine to a different region/provider
 */
router.post('/:id/migrate', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { targetProvider, targetRegion, targetQuality } = req.body;

    // TODO: Verify ownership
    // TODO: Start migration orchestration
    // TODO: Return migration status

    res.status(501).json({ error: 'Not yet implemented' });
  } catch (error) {
    console.error('Migrate machine error:', error);
    res.status(500).json({ error: 'Failed to migrate machine' });
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

    // TODO: Verify ownership
    // TODO: Call cloud provider to terminate
    // TODO: Delete machine record

    res.status(501).json({ error: 'Not yet implemented' });
  } catch (error) {
    console.error('Delete machine error:', error);
    res.status(500).json({ error: 'Failed to delete machine' });
  }
});

export default router;
