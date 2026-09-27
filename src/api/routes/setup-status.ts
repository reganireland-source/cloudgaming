import { Router, Request, Response } from 'express';
import { query } from '../../config/database';
import { authenticateToken } from '../middleware/auth';

const router = Router();

interface SetupStatus {
  machineId: string;
  stage: 'initializing' | 'waiting_for_instance' | 'installing_drivers' | 'installing_cloudypad' | 'configuring_sunshine' | 'installing_clients' | 'starting_service' | 'complete' | 'failed';
  progress: number;
  message: string;
  sunshinePin?: string;
  sunshineUrl?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

router.get('/:machineId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;
    const userId = (req as any).userId;

    const machineResult = await query(
      'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
      [machineId, userId]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    const setupResult = await query(
      'SELECT * FROM setup_status WHERE machine_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [machineId]
    );

    if (setupResult.rows.length === 0) {
      return res.status(404).json({
        stage: 'initializing',
        progress: 0,
        message: 'Setup not started yet',
        machineId
      });
    }

    const status = setupResult.rows[0];
    res.json({
      machineId,
      stage: status.stage,
      progress: status.progress,
      message: status.message,
      sunshinePin: status.sunshine_pin,
      sunshineUrl: status.sunshine_url,
      error: status.error_message,
      startedAt: status.created_at,
      updatedAt: status.updated_at,
    } as SetupStatus);
  } catch (error) {
    console.error('Setup status fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch setup status' });
  }
});

router.post('/:machineId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;
    const userId = (req as any).userId;
    const { stage, progress, message, sunshinePin, sunshineUrl, error } = req.body;

    const machineResult = await query(
      'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
      [machineId, userId]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    const insertResult = await query(
      `INSERT INTO setup_status (
        machine_id, stage, progress, message, sunshine_pin, sunshine_url, error_message, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      RETURNING *`,
      [machineId, stage, progress || 0, message, sunshinePin, sunshineUrl, error]
    );

    const status = insertResult.rows[0];
    res.json({
      machineId,
      stage: status.stage,
      progress: status.progress,
      message: status.message,
      sunshinePin: status.sunshine_pin,
      sunshineUrl: status.sunshine_url,
      error: status.error_message,
      startedAt: status.created_at,
      updatedAt: status.updated_at,
    } as SetupStatus);
  } catch (error) {
    console.error('Setup status update error:', error);
    res.status(500).json({ error: 'Failed to update setup status' });
  }
});

export default router;
