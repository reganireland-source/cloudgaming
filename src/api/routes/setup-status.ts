/**
 * ============================================================================
 * src/api/routes/setup-status.ts — PROGRESS OF A NEW MACHINE'S SETUP
 * ============================================================================
 *
 * After a machine is launched, the backend spends several minutes preparing
 * it: waiting for it to boot, installing GPU drivers, installing the
 * streaming server (Sunshine), and so on. The frontend shows a live
 * progress bar for this (frontend/components/SetupStatusMonitor.tsx), and
 * it gets its data from here.
 *
 * Mounted at /api/setup-status (login required):
 *   GET  /api/setup-status/:machineId   latest progress for a machine
 *   POST /api/setup-status/:machineId   record a new progress update
 *
 * Each progress update is a NEW ROW in the `setup_status` table (a history),
 * and GET returns only the newest one.
 *
 * NOTE: CloudyPadSetup (src/utils/CloudyPadSetup.ts) can report progress
 * through a callback, but MachineService doesn't yet pass one in, so today
 * nothing automatically POSTs updates here during a real launch.
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { query } from '../../config/database';

const router = Router();

/**
 * The shape of one progress report sent to the frontend.
 * `stage` can only be one of the listed step names — TypeScript enforces it.
 */
interface SetupStatus {
  machineId: string;
  stage: 'initializing' | 'waiting_for_instance' | 'installing_drivers' | 'installing_cloudypad' | 'configuring_sunshine' | 'installing_clients' | 'starting_service' | 'complete' | 'failed';
  progress: number;       // 0 to 100 (percent)
  message: string;        // human-readable description of what's happening
  sunshinePin?: string;   // pairing code, once setup is complete
  sunshineUrl?: string;   // address of the Sunshine web page on the machine
  error?: string;         // what went wrong, if stage is 'failed'
  startedAt: string;
  updatedAt: string;
}

/**
 * GET /api/setup-status/:machineId
 * The most recent progress report for one of MY machines.
 */
router.get('/:machineId', async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;
    const userId = (req as any).userId;

    // Ownership check: only find the machine if it belongs to this user.
    const machineResult = await query(
      'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
      [machineId, userId]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    // Newest row only: sort by updated_at, newest first (DESC =
    // descending), and take just the first (LIMIT 1).
    const setupResult = await query(
      'SELECT * FROM setup_status WHERE machine_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [machineId]
    );

    // No reports yet: answer with a sensible "not started" placeholder
    // (still marked 404 so callers can tell nothing has been recorded).
    if (setupResult.rows.length === 0) {
      return res.status(404).json({
        stage: 'initializing',
        progress: 0,
        message: 'Setup not started yet',
        machineId
      });
    }

    const status = setupResult.rows[0];

    // Convert database column names (snake_case) to the camelCase names
    // the frontend expects. `as SetupStatus` asks TypeScript to check the
    // object matches that shape.
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

/**
 * POST /api/setup-status/:machineId
 * Record a new progress update.
 * Body: { stage, progress, message, sunshinePin?, sunshineUrl?, error? }
 */
router.post('/:machineId', async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;
    const userId = (req as any).userId;
    const { stage, progress, message, sunshinePin, sunshineUrl, error } = req.body;

    // Ownership check.
    const machineResult = await query(
      'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
      [machineId, userId]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    // Add a new history row. NOW() is Postgres's current timestamp.
    // RETURNING * sends back the complete saved row.
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
