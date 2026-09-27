/**
 * ============================================================================
 * src/services/MachineService.ts — THE LIFE CYCLE OF A GAMING MACHINE
 * ============================================================================
 *
 * WHAT A "SERVICE" IS
 * -------------------
 * Route files (src/api/routes/) deal with HTTP: reading requests and sending
 * responses. SERVICES hold the actual business logic, so it can be reused and
 * read without HTTP noise. routes/machines.ts calls these functions.
 *
 * WHAT THIS SERVICE DOES (works the same for every cloud)
 * -------------------------------------------------------
 *   launch     create a GPU machine in the user's own cloud account
 *   start      power a stopped machine back on
 *   stop       power it off (optionally snapshotting its disk first)
 *   remove     destroy it at the cloud, then forget it
 *   sync       ask the cloud for the machine's real state and IP
 *   connection how to connect: IP, Sunshine login, setup progress
 *
 * THE PATTERN
 * -----------
 * Every action that talks to a cloud:
 *   1. checks the machine belongs to the user and isn't already busy,
 *   2. creates an OPERATION (services/OperationLog.ts) and returns its id
 *      straight away — the browser then shows its live commentary,
 *   3. does the slow cloud work in the background, narrating each step,
 *   4. records the result (or a plain-English error card) on the operation
 *      and updates the machine row.
 *
 * SAFETY FIRST: THE ROW EXISTS BEFORE THE MACHINE DOES
 * ----------------------------------------------------
 * launch() inserts the machine row (status 'creating') BEFORE asking the
 * cloud to create anything. If the backend crashes halfway, the row is still
 * there, so a machine can never end up running (and billing) without
 * appearing in the app.
 *
 * Credentials come from CredentialService (encrypted per user). The
 * provider objects narrate into the operation via setReporter.
 * ============================================================================
 */

import crypto from 'crypto';
import { query } from '../config/database';
import { CATALOGS, isProviderName } from '../providers/registry';
import { FriendlyCloudError } from '../providers/errors';
import { decryptCredentials, encryptCredentials, providerFor } from './CredentialService';
import { Operation, hasRunningOperation } from './OperationLog';
import { SnapshotService } from './SnapshotService';

const VALID_QUALITIES = ['budget', 'good', 'high', 'ultra'];

/** A machine is "busy" in these states — don't start another action. */
const BUSY_STATES = ['creating', 'starting', 'stopping', 'deleting'];

export interface LaunchRequest {
  provider: string;
  region: string;
  shapeId: string;          // catalog shape id, e.g. 'n1-standard-4+t4'
  gameTitle?: string;
  quality?: string;
  spot?: boolean;
  diskSizeGb?: number;
}

/** A plain-English "you can't do that" (turned into HTTP 400/404/409 by the route). */
export class MachineRequestError extends Error {
  constructor(public readonly status: number, message: string, public readonly tip?: string) {
    super(message);
  }
}

/** The machine row, checked for ownership. Throws 404 if not theirs. */
async function loadOwnedMachine(machineId: string, userId: string): Promise<any> {
  const result = await query('SELECT * FROM machines WHERE id = $1 AND user_id = $2', [machineId, userId]);
  if (result.rows.length === 0) {
    throw new MachineRequestError(404, 'Machine not found.', 'It may have been deleted. Refresh the page.');
  }
  return result.rows[0];
}

/** Refuse to start a second action while one is still running on this machine. */
async function assertNotBusy(machine: any): Promise<void> {
  if (await hasRunningOperation(machine.id)) {
    throw new MachineRequestError(409, 'This machine is busy with another action.',
      'Wait for it to finish — its progress is shown in the Activity panel.');
  }
}

/** A machine that never got created at the cloud (launch failed early). */
function neverCreated(machine: any): boolean {
  return String(machine.instance_id).startsWith('pending:');
}

async function setStatus(machineId: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const sets = ['status = $2'];
  const values: unknown[] = [machineId, status];
  for (const [column, value] of Object.entries(extra)) {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  await query(`UPDATE machines SET ${sets.join(', ')} WHERE id = $1`, values);
}

export class MachineService {
  // ==========================================================================
  // Launch
  // ==========================================================================

  /**
   * Validate a launch request against the provider's catalog, record the
   * machine, and start creating it in the background.
   * @returns the new machine id and the operation id to watch
   */
  static async launch(userId: string, req: LaunchRequest): Promise<{ machineId: string; operationId: string }> {
    // ---- 1. Validate everything we can BEFORE touching the cloud ----------
    if (!isProviderName(req.provider)) {
      throw new MachineRequestError(400, `Unknown cloud "${req.provider}".`, 'Choose Google Cloud, AWS, Azure or Oracle.');
    }
    const catalog = CATALOGS[req.provider];
    const shape = catalog.shapes.find((s) => s.id === req.shapeId);
    if (!shape) {
      throw new MachineRequestError(400, `"${req.shapeId}" isn't a machine type we offer on ${catalog.label}.`,
        `Choose one of: ${catalog.shapes.map((s) => s.label).join(', ') || '(none available yet)'}.`);
    }
    const region = catalog.regions.find((r) => r.id === req.region);
    if (!region) {
      throw new MachineRequestError(400, `"${req.region}" isn't a region we launch in on ${catalog.label}.`,
        `Choose one of: ${catalog.regions.map((r) => `${r.name} (${r.id})`).join(', ')}.`);
    }
    if (!region.gpus.includes(shape.gpuModel)) {
      throw new MachineRequestError(400, `${shape.gpuModel} GPUs aren't offered in ${region.name}.`,
        `In ${region.name} you can use: ${region.gpus.join(', ')}.`);
    }
    const quality = (req.quality || 'high').toLowerCase();
    if (!VALID_QUALITIES.includes(quality)) {
      throw new MachineRequestError(400, `Unknown streaming quality "${req.quality}".`, `Use one of: ${VALID_QUALITIES.join(', ')}.`);
    }
    const spot = !!req.spot && catalog.supportsSpot;
    const diskSizeGb = Math.round(Number(req.diskSizeGb) || catalog.defaultDiskGb);
    if (diskSizeGb < catalog.minDiskGb || diskSizeGb > 2000) {
      throw new MachineRequestError(400, `Disk size must be between ${catalog.minDiskGb} and 2000 GB.`,
        'Most games need 50–150 GB; the OS and drivers use about 20 GB.');
    }
    // Fail fast (and clearly) if the user hasn't added keys for this cloud.
    // Loading also proves they can be decrypted.
    await providerFor(userId, req.provider);

    // ---- 2. Record the machine first (see "SAFETY FIRST" above) ------------
    const costPerHour = catalog.estimateHourly(shape.id, region.id, spot);
    // The streaming server's admin login for this machine: random, and stored
    // encrypted. base64url only uses letters, digits, '-' and '_'.
    const sunshine = { username: 'gamer', password: crypto.randomBytes(12).toString('base64url') };
    const machineId = crypto.randomUUID();
    await query(
      `INSERT INTO machines (id, user_id, provider, region, instance_type, instance_id, status, cost_per_hour,
                             streaming_quality, game_title, spot, disk_size_gb, connection_secret, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'creating', $7, $8, $9, $10, $11, $12, NOW())`,
      [machineId, userId, req.provider, region.id, shape.id, `pending:${machineId}`, costPerHour, quality,
       req.gameTitle || null, spot, diskSizeGb, encryptCredentials(userId, `sunshine:${machineId}`, sunshine)]
    );

    // ---- 3. Create it in the background, narrating every step --------------
    const op = await Operation.start({
      userId, provider: req.provider, action: 'launch', machineId,
      title: `Launch ${shape.label} on ${catalog.label} in ${region.name}${spot ? ` (${catalog.spotLabel})` : ''}`,
    });
    op.runInBackground(async () => {
      try {
        await op.info(`Estimated cost while running: about $${costPerHour.toFixed(2)}/hour` +
          ` (+ about $${(diskSizeGb * catalog.diskPerGbMonth).toFixed(2)}/month for the ${diskSizeGb} GB disk, even when stopped).`);
        await op.info('Loading your encrypted cloud credentials…');
        const provider = await providerFor(userId, req.provider, op.reporter);
        if ((provider as any).projectId) op.projectId = (provider as any).projectId;

        const result = await provider.launchInstance(
          { region: region.id, instanceType: shape.id },
          {
            imageId: '', keyName: '', securityGroupId: '', // legacy fields, unused by current providers
            spotInstance: spot,
            diskSizeGb,
            sunshineUsername: sunshine.username,
            sunshinePassword: sunshine.password,
          }
        );

        await setStatus(machineId, 'running', {
          instance_id: result.instanceId,
          ip_address: result.ipAddress || null,
          cost_per_hour: result.costPerHour || costPerHour,
          last_started: new Date(),
          last_error: null,
          last_synced_at: new Date(),
        });
        await op.success(`Machine is running${result.ipAddress ? ` at ${result.ipAddress}` : ''}.`);
        if (provider.selfConfiguring) {
          await op.info('It is now installing the GPU driver, desktop and Sunshine by itself (about 10–20 minutes, including one reboot). Watch "Setup progress" on the machine.');
        }
        return { machineId, instanceId: result.instanceId, ipAddress: result.ipAddress };
      } catch (error) {
        // Record the failure on the machine too, so the card can show it.
        const friendly = await op.fail(error).catch(() => null);
        await setStatus(machineId, 'failed', { last_error: friendly ? JSON.stringify(friendly) : null }).catch(() => {});
        throw new AlreadyRecorded();
      }
    }, 'Launch finished.');

    return { machineId, operationId: op.id };
  }

  // ==========================================================================
  // Start / stop / delete / sync
  // ==========================================================================

  static async start(userId: string, machineId: string): Promise<{ operationId: string }> {
    const machine = await loadOwnedMachine(machineId, userId);
    await assertNotBusy(machine);
    if (neverCreated(machine)) throw new MachineRequestError(409, 'This machine was never created at the cloud.', 'Delete it and launch a new one.');

    const op = await Operation.start({ userId, provider: machine.provider, action: 'start', machineId, title: `Start ${machine.instance_type} in ${machine.region}` });
    await setStatus(machineId, 'starting');
    op.runInBackground(async () => {
      try {
        const provider = await providerFor(userId, machine.provider, op.reporter);
        if ((provider as any).projectId) op.projectId = (provider as any).projectId;
        await provider.startInstance(machine.instance_id);
        const status = await provider.getInstanceStatus(machine.instance_id);
        await setStatus(machineId, status.status === 'terminated' ? 'failed' : status.status, {
          ip_address: status.ipAddress || null, last_started: new Date(), last_error: null, last_synced_at: new Date(),
        });
        if (status.ipAddress && status.ipAddress !== machine.ip_address) {
          await op.warn(`The machine's public IP changed to ${status.ipAddress}. If Moonlight can't find it, add this new IP there.`);
        }
        await op.info(`Billing resumed: about $${Number(machine.cost_per_hour || 0).toFixed(2)}/hour while it runs.`);
        return { ipAddress: status.ipAddress };
      } catch (error) {
        await MachineService.resyncQuietly(userId, machine);
        throw error;
      }
    }, 'Machine started.');
    return { operationId: op.id };
  }

  static async stop(userId: string, machineId: string, snapshotFirst = false): Promise<{ operationId: string }> {
    const machine = await loadOwnedMachine(machineId, userId);
    await assertNotBusy(machine);
    if (neverCreated(machine)) throw new MachineRequestError(409, 'This machine was never created at the cloud.', 'Delete it instead.');

    const op = await Operation.start({ userId, provider: machine.provider, action: 'stop', machineId, title: `Stop ${machine.instance_type} in ${machine.region}` });
    await setStatus(machineId, 'stopping');
    op.runInBackground(async () => {
      try {
        const provider = await providerFor(userId, machine.provider, op.reporter);
        if ((provider as any).projectId) op.projectId = (provider as any).projectId;
        if (snapshotFirst) {
          await op.info('Taking a snapshot of the disk first (a backup you can restore later)…');
          try {
            await SnapshotService.createSnapshot({ machineId, userId, paths: ['/'], description: `Snapshot before stop (${machine.region})` });
            await op.success('Snapshot saved.');
          } catch (error) {
            // Stopping matters more than the backup: a running machine costs money.
            await op.warn('The snapshot failed, but the machine will still be stopped.', (error as Error).message);
          }
        }
        await provider.stopInstance(machine.instance_id);
        await setStatus(machineId, 'stopped', { last_error: null, last_synced_at: new Date() });
        await op.info('Compute billing has stopped. The disk is kept (a small monthly storage charge) so your games are still there next time.');
        return { stopped: true };
      } catch (error) {
        await MachineService.resyncQuietly(userId, machine);
        throw error;
      }
    }, 'Machine stopped.');
    return { operationId: op.id };
  }

  static async remove(userId: string, machineId: string): Promise<{ operationId: string | null }> {
    const machine = await loadOwnedMachine(machineId, userId);
    await assertNotBusy(machine);

    // Never created at the cloud → nothing to destroy, just forget it.
    if (neverCreated(machine)) {
      await query('DELETE FROM machines WHERE id = $1', [machineId]);
      return { operationId: null };
    }

    const op = await Operation.start({ userId, provider: machine.provider, action: 'delete', machineId, title: `Delete ${machine.instance_type} in ${machine.region}` });
    await setStatus(machineId, 'deleting');
    op.runInBackground(async () => {
      try {
        const provider = await providerFor(userId, machine.provider, op.reporter);
        if ((provider as any).projectId) op.projectId = (provider as any).projectId;
        await provider.terminateInstance(machine.instance_id);
        // Keep the operation history but drop the machine; snapshots rows keep
        // existing (their machine_id becomes NULL) because they still cost money
        // at the cloud until deleted there.
        await query('DELETE FROM machines WHERE id = $1', [machineId]);
        await op.info('The machine and its disk are gone. Nothing more will be billed for them.');
        return { deleted: true };
      } catch (error) {
        await MachineService.resyncQuietly(userId, machine);
        throw error;
      }
    }, 'Machine deleted.');
    return { operationId: op.id };
  }

  /** Ask the cloud for the real state (e.g. after a change in the cloud console). */
  static async sync(userId: string, machineId: string): Promise<{ operationId: string }> {
    const machine = await loadOwnedMachine(machineId, userId);
    if (neverCreated(machine)) throw new MachineRequestError(409, 'This machine was never created at the cloud.', 'Delete it and launch a new one.');
    const op = await Operation.start({ userId, provider: machine.provider, action: 'sync', machineId, title: `Check the real state of ${machine.instance_type}` });
    op.runInBackground(async () => {
      const provider = await providerFor(userId, machine.provider, op.reporter);
      if ((provider as any).projectId) op.projectId = (provider as any).projectId;
      await op.info('Asking the cloud for the machine\'s current state…');
      const status = await provider.getInstanceStatus(machine.instance_id);
      await setStatus(machineId, status.status === 'terminated' ? 'missing' : status.status, {
        ip_address: status.ipAddress || machine.ip_address || null, last_synced_at: new Date(),
      });
      if (status.status === 'terminated') {
        await op.warn('The cloud says this machine no longer exists (deleted outside the app?). Delete it here to clean up.');
      } else {
        await op.success(`The cloud says: ${status.status}${status.ipAddress ? `, IP ${status.ipAddress}` : ''}.`);
      }
      return status;
    }, 'State refreshed.');
    return { operationId: op.id };
  }

  /** Update our record quietly after a failure, so the UI doesn't show a stale state. */
  private static async resyncQuietly(userId: string, machine: any): Promise<void> {
    try {
      const provider = await providerFor(userId, machine.provider);
      const status = await provider.getInstanceStatus(machine.instance_id);
      await setStatus(machine.id, status.status === 'terminated' ? 'missing' : status.status, {
        ip_address: status.ipAddress || machine.ip_address || null, last_synced_at: new Date(),
      });
    } catch {
      await setStatus(machine.id, 'unknown').catch(() => {});
    }
  }

  // ==========================================================================
  // Connecting
  // ==========================================================================

  /**
   * Everything needed to connect: IP, the Sunshine admin login, and the
   * progress of the on-machine setup (read from the serial console).
   */
  static async connection(userId: string, machineId: string) {
    const machine = await loadOwnedMachine(machineId, userId);
    let login: { username?: string; password?: string } = {};
    if (machine.connection_secret) {
      try {
        login = decryptCredentials(userId, `sunshine:${machineId}`, machine.connection_secret);
      } catch { /* shown as unavailable */ }
    }

    let stages: Array<{ percent: number; key: string; message: string }> = [];
    let progressError: string | undefined;
    if (!neverCreated(machine) && ['running', 'starting'].includes(machine.status)) {
      try {
        const provider = await providerFor(userId, machine.provider);
        stages = await provider.getSetupProgress(machine.instance_id);
      } catch (error) {
        progressError = error instanceof FriendlyCloudError ? error.friendly.title : 'Couldn\'t read the machine\'s console yet.';
      }
    }
    const current = stages[stages.length - 1];

    return {
      machineId,
      provider: machine.provider,
      status: machine.status,
      ipAddress: machine.ip_address,
      sunshineUrl: machine.ip_address ? `https://${machine.ip_address}:47990` : null,
      username: login.username,
      password: login.password,
      setup: {
        stages,
        current: current || null,
        ready: current?.key === 'ready',
        failed: current?.key === 'failed',
        error: progressError,
      },
    };
  }

  /** Change the streaming preset (saved; applied by Sunshine's own settings page). */
  static async updateQuality(userId: string, machineId: string, newQuality: string) {
    const quality = String(newQuality || '').toLowerCase();
    if (!VALID_QUALITIES.includes(quality)) {
      throw new MachineRequestError(400, `Unknown streaming quality "${newQuality}".`, `Use one of: ${VALID_QUALITIES.join(', ')}.`);
    }
    const machine = await loadOwnedMachine(machineId, userId);
    const updated = await query('UPDATE machines SET streaming_quality = $1 WHERE id = $2 RETURNING *', [quality, machineId]);
    await query(
      `INSERT INTO quality_updates (machine_id, user_id, old_quality, new_quality, reason) VALUES ($1, $2, $3, $4, $5)`,
      [machineId, userId, machine.streaming_quality || 'high', quality, 'User-initiated quality update']
    ).catch(() => { /* audit table is optional */ });
    return updated.rows[0];
  }

  /** Is this machine in a state where a new action makes sense? */
  static isBusy(status: string): boolean {
    return BUSY_STATES.includes(status);
  }
}

/**
 * Thrown inside launch's background work after the failure has ALREADY been
 * recorded (so runInBackground doesn't record it a second time).
 */
class AlreadyRecorded extends Error {
  constructor() {
    super('already recorded');
    this.name = 'AlreadyRecorded';
  }
}
export { AlreadyRecorded };
