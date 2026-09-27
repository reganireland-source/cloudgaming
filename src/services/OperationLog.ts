/**
 * ============================================================================
 * src/services/OperationLog.ts — A RUNNING COMMENTARY FOR EVERY CLOUD ACTION
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Talking to a cloud is slow (launching a GPU machine takes 30–90 seconds)
 * and fails in many ways (no GPU quota, zone sold out, API switched off...).
 * If the browser just waits on one long request, you see a spinner and then,
 * at best, a cryptic error — and you end up in the Google Cloud console
 * trying to work out what happened.
 *
 * Instead, every cloud action becomes an OPERATION:
 *   1. The route creates it and replies IMMEDIATELY with its id (HTTP 202,
 *      "Accepted — working on it").
 *   2. The actual work carries on in the background, writing short EVENTS
 *      as it goes: "Checking credentials… ✓", "Trying zone -a…".
 *   3. The frontend polls GET /api/operations/:id about once a second and
 *      shows the events as a live console.
 *   4. At the end the operation is marked succeeded or failed. A failure
 *      stores a plain-English error card (see src/providers/gcp/errors.ts)
 *      with what went wrong and how to fix it.
 *
 * Everything is stored in two tables (database/migrations/006_...sql):
 * cloud_operations (one row per action) and cloud_operation_events (the
 * lines of commentary).
 *
 * HOW TO USE IT
 * -------------
 *   const op = await Operation.start({ userId, provider: 'gcp', action: 'stop',
 *                                       title: 'Stop machine cg-1a2b', machineId });
 *   op.runInBackground(async () => {
 *     await op.info('Asking Google Cloud to stop the machine…');
 *     ...
 *     return { stopped: true };      // saved as the operation's result
 *   });
 *   res.status(202).json({ operationId: op.id });
 * ============================================================================
 */

import { query } from '../config/database';
import { FriendlyError, toFriendlyError } from '../providers/gcp/errors';

export type EventLevel = 'info' | 'success' | 'warn' | 'error';

/** A function that providers call to add a line of commentary. */
export type Reporter = (level: EventLevel, message: string, detail?: string) => Promise<void> | void;

export class Operation {
  // `private constructor`: you can't `new Operation(...)` from outside —
  // use Operation.start(), which also creates the database row.
  private constructor(
    public readonly id: string,
    public readonly provider: string
  ) {}

  /**
   * The user's cloud project (GCP), once known. Only used so that error
   * cards can link straight to the right page of the user's console.
   */
  projectId?: string;

  /** Create the operation row and return an object for logging to it. */
  static async start(params: {
    userId: string;
    provider: string;
    action: string;
    title: string;
    machineId?: string | null;
  }): Promise<Operation> {
    const result = await query(
      `INSERT INTO cloud_operations (user_id, machine_id, provider, action, title)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [params.userId, params.machineId || null, params.provider, params.action, params.title]
    );
    const op = new Operation(result.rows[0].id, params.provider);
    await op.info(params.title);
    return op;
  }

  /**
   * Add one line of commentary. Also echoed to the server log (Railway →
   * Deployments → View logs) with the operation id, for debugging.
   *
   * Never throws: failing to WRITE a log line must not break the actual
   * cloud action, so database errors here are only printed.
   */
  async log(level: EventLevel, message: string, detail?: string): Promise<void> {
    console.log(`[op ${this.id.slice(0, 8)}] ${level.toUpperCase()}: ${message}${detail ? ` (${detail})` : ''}`);
    try {
      await query(
        `INSERT INTO cloud_operation_events (operation_id, level, message, detail)
         VALUES ($1, $2, $3, $4)`,
        [this.id, level, message, detail || null]
      );
    } catch (error) {
      console.error('[OperationLog] could not write event:', error);
    }
  }

  // Shorthands so calling code reads naturally: op.info('...'), op.warn('...').
  info(message: string, detail?: string) { return this.log('info', message, detail); }
  success(message: string, detail?: string) { return this.log('success', message, detail); }
  warn(message: string, detail?: string) { return this.log('warn', message, detail); }

  /**
   * The same logger as a plain function, to hand to a cloud provider
   * (provider.setReporter(op.reporter)) so it can narrate its own steps.
   * An arrow function keeps `this` pointing at this operation.
   */
  reporter: Reporter = (level, message, detail) => this.log(level, message, detail);

  /** Point the operation at a machine (e.g. once a launch has created its row). */
  async attachMachine(machineId: string): Promise<void> {
    await query('UPDATE cloud_operations SET machine_id = $1 WHERE id = $2', [machineId, this.id]);
  }

  /** Mark finished successfully, storing an optional result object. */
  async succeed(result?: unknown, message = 'Done.'): Promise<void> {
    await this.success(message);
    await query(
      `UPDATE cloud_operations SET status = 'succeeded', result = $1, finished_at = NOW() WHERE id = $2`,
      [result === undefined ? null : JSON.stringify(result), this.id]
    );
  }

  /**
   * Mark failed. Turns whatever was thrown into a plain-English error card
   * and writes its title as the last line of commentary.
   */
  async fail(error: unknown): Promise<FriendlyError> {
    const friendly = toFriendlyError(error, this.provider, this.projectId);
    await this.log('error', friendly.title, friendly.raw);
    await query(
      `UPDATE cloud_operations SET status = 'failed', error = $1, finished_at = NOW() WHERE id = $2`,
      [JSON.stringify(friendly), this.id]
    );
    return friendly;
  }

  /**
   * Run `work` WITHOUT waiting for it (the caller replies to the browser
   * straight away). Whatever `work` returns becomes the result; anything it
   * throws becomes the failure. Nothing escapes as an unhandled rejection,
   * which would crash the Node process.
   */
  runInBackground(work: () => Promise<unknown>, successMessage?: string): void {
    // `void` marks this promise as deliberately not awaited.
    void (async () => {
      try {
        const result = await work();
        await this.succeed(result, successMessage);
      } catch (error) {
        // The work may have recorded its own failure already (see
        // MachineService.launch); don't record it twice.
        if ((error as Error)?.name === 'AlreadyRecorded') return;
        console.error(`[op ${this.id.slice(0, 8)}] failed:`, error);
        try {
          await this.fail(error);
        } catch (inner) {
          console.error('[OperationLog] could not record failure:', inner);
        }
      }
    })();
  }
}

/**
 * Read one operation with its events, for GET /api/operations/:id.
 * `afterEventId` lets the frontend fetch only NEW lines on each poll.
 * Returns null if it doesn't exist or belongs to someone else.
 */
export async function getOperation(operationId: string, userId: string, afterEventId = 0) {
  const opResult = await query(
    `SELECT id, machine_id, provider, action, title, status, error, result, created_at, finished_at
     FROM cloud_operations WHERE id = $1 AND user_id = $2`,
    [operationId, userId]
  );
  if (opResult.rows.length === 0) return null;

  const events = await query(
    `SELECT id, level, message, detail, created_at
     FROM cloud_operation_events
     WHERE operation_id = $1 AND id > $2
     ORDER BY id ASC`,
    [operationId, afterEventId]
  );

  // BIGSERIAL ids come back from `pg` as text (they can exceed JavaScript's
  // safe integer range in theory); convert them to numbers for the frontend.
  return {
    ...opResult.rows[0],
    events: events.rows.map((e: any) => ({ ...e, id: Number(e.id) })),
  };
}

/** The most recent operations for a user (the "Activity" panel). */
export async function listOperations(userId: string, limit = 20, machineId?: string) {
  const params: unknown[] = [userId, Math.min(Math.max(limit, 1), 100)];
  let filter = '';
  if (machineId) {
    params.push(machineId);
    filter = 'AND machine_id = $3';
  }
  const result = await query(
    `SELECT o.id, o.machine_id, o.provider, o.action, o.title, o.status, o.error,
            o.created_at, o.finished_at,
            (SELECT message FROM cloud_operation_events e
              WHERE e.operation_id = o.id ORDER BY e.id DESC LIMIT 1) AS last_message
     FROM cloud_operations o
     WHERE o.user_id = $1 ${filter}
     ORDER BY o.created_at DESC
     LIMIT $2`,
    params
  );
  return result.rows;
}

/**
 * Is some operation still running on this machine? Used to refuse a second
 * start/stop/delete while the first is in progress.
 */
export async function hasRunningOperation(machineId: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM cloud_operations
     WHERE machine_id = $1 AND status = 'running'
       AND created_at > NOW() - INTERVAL '30 minutes'`,
    [machineId]
  );
  return result.rows.length > 0;
}

/**
 * On server start: any operation still marked 'running' belonged to the
 * previous server process, which is gone (a redeploy or crash), so it will
 * never finish. Mark those as failed with an explanation, rather than
 * leaving the frontend spinning forever.
 */
export async function failOrphanedOperations(): Promise<void> {
  try {
    const orphaned = await query(
      `UPDATE cloud_operations
       SET status = 'failed', finished_at = NOW(),
           error = $1
       WHERE status = 'running'
       RETURNING id`,
      [
        JSON.stringify({
          code: 'SERVER_RESTARTED',
          title: 'Interrupted by a backend restart',
          explanation:
            'The backend restarted (usually a new deploy on Railway) while this was in progress, so it lost track of it. The cloud may or may not have finished the job.',
          fixes: [
            'Press "Sync" on the machine to read its real state from the cloud.',
            'If it is in the wrong state, run the action again.',
          ],
        }),
      ]
    );
    for (const row of orphaned.rows) {
      await query(
        `INSERT INTO cloud_operation_events (operation_id, level, message)
         VALUES ($1, 'error', 'Interrupted: the backend restarted before this finished.')`,
        [row.id]
      );
    }
    if (orphaned.rows.length > 0) {
      console.log(`[OperationLog] marked ${orphaned.rows.length} interrupted operation(s) as failed`);
    }
  } catch (error) {
    // The table may not exist yet on a brand-new database; that's fine.
    console.error('[OperationLog] could not clean up orphaned operations:', error);
  }
}
