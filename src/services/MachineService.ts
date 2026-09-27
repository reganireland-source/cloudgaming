/**
 * ============================================================================
 * src/services/MachineService.ts — THE LIFE CYCLE OF A GAMING MACHINE
 * ============================================================================
 *
 * WHAT A "SERVICE" IS
 * -------------------
 * Route files (src/api/routes/) deal with HTTP: reading requests and sending
 * responses. SERVICES hold the actual business logic — the multi-step
 * procedures — so they can be reused and read without HTTP noise.
 * machines.ts (the route) calls these functions.
 *
 * WHAT THIS SERVICE DOES
 * ----------------------
 *   launchMachine          create a VM at the cloud, set it up, record it
 *   stopMachine            (optionally snapshot, then) power it off
 *   startMachine           power it back on
 *   migrateMachine         move it to another region/cloud via a snapshot
 *   updateStreamingQuality change the Budget/Good/High/Ultra preset
 *   deleteMachine          destroy it and forget it
 *
 * THE PATTERN YOU'LL SEE REPEATED
 * -------------------------------
 *   1. Load the machine row, filtered by BOTH id and user_id (ownership).
 *   2. Load that user's saved credentials for the machine's cloud.
 *   3. getProvider(...) -> an object that knows how to talk to that cloud.
 *   4. Ask the cloud to do the thing.
 *   5. Update our database to match.
 *
 * `static` METHODS
 * ----------------
 * Every method is `static`, meaning you call it on the class itself
 * (MachineService.launchMachine(...)) without creating an object first —
 * the class is just a tidy namespace for related functions.
 *
 * ⚠️  KNOWN ISSUES (worth fixing before real use)
 * ---------------------------------------------
 * 1. launchMachine waits for the ENTIRE machine setup (SSH, driver install,
 *    Sunshine…) before replying — potentially many minutes, during which the
 *    browser's request just hangs and may time out. The setup should run in
 *    the background, with the frontend polling /api/setup-status.
 * 2. The machine's IP address is never saved (there's no ip_address column),
 *    which breaks streaming details and the quality update below.
 * 3. REGRESSION: stopMachine creates a snapshot via SnapshotService, but that
 *    service does not write the new snapshot's id into machines.snapshot_id
 *    (the older inline code did). migrateMachine relies on that column, so
 *    migrating a machine that had no snapshot will now fail.
 * 4. Credentials are read with JSON.parse — they are NOT encrypted.
 * 5. Several methods read credsResult.rows[0] without checking it exists;
 *    if the user has deleted their credentials that throws a confusing
 *    "Cannot read properties of undefined" error.
 * 6. launchMachine uses a placeholder security group id and a fixed key
 *    name 'cloudgaming-key' — both must exist in your AWS account.
 * ============================================================================
 */

import { query } from '../config/database';
import { getProvider } from '../providers';
import { Machine, Snapshot } from '../types';
// uuid generates random unique ids like "3f1c9e2a-...". `v4 as uuidv4`
// imports the function named v4 but lets us call it uuidv4 here.
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto'; // imported but currently unused (intended for encrypting credentials)
import { CloudyPadSetup } from '../utils/CloudyPadSetup';
import { SnapshotService } from './SnapshotService';
import { env } from '../config/env';

export class MachineService {
  /**
   * Launch a new gaming machine, end to end.
   *
   * @param streamingQuality defaults to 'high' if not given (the `= 'high'`)
   * @returns the new row from the machines table
   * @throws if the quality is invalid, the user has no credentials for the
   *         cloud, the credentials are rejected, or the launch fails
   */
  static async launchMachine(
    userId: string,
    provider: string,
    region: string,
    instanceType: string,
    gameTitle: string,
    streamingQuality: string = 'high'
  ): Promise<Machine> {
    // Accept 'High', 'HIGH', 'high' alike by lower-casing first, then check
    // it's one of the four presets.
    const validQualities = ['budget', 'good', 'high', 'ultra'];
    const normalizedQuality = streamingQuality.toLowerCase();
    if (!validQualities.includes(normalizedQuality)) {
      throw new Error(
        `Invalid streaming quality: ${streamingQuality}. Must be one of: ${validQualities.join(', ')}`
      );
    }
    try {
      // 1. This user's saved credentials for the chosen cloud.
      const credsResult = await query(
        'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
        [userId, provider]
      );

      if (credsResult.rows.length === 0) {
        throw new Error(`No credentials found for provider: ${provider}`);
      }

      const encryptedCreds = credsResult.rows[0].encrypted_data;
      // The stored text is JSON; parse it back into an object.
      const credentials = JSON.parse(encryptedCreds); // In production, decrypt first

      // 2. Get the right cloud "driver" (AWSProvider for 'aws', etc.).
      const cloudProvider = getProvider(provider, credentials);

      // 3. Fail early with a clear message if the credentials don't work,
      //    rather than halfway through launching.
      const valid = await cloudProvider.validateCredentials();
      if (!valid) {
        throw new Error('Invalid cloud credentials');
      }

      // 4. Ask the cloud to create and boot the machine.
      console.log(`Launching ${instanceType} in ${region}...`);
      const launchResult = await cloudProvider.launchInstance(
        { region, instanceType },
        {
          imageId: env.CLOUDGAMING_AMI_ID, // From CLOUDGAMING_AMI_ID env var (our pre-built gaming image)
          keyName: 'cloudgaming-key',      // must already exist in your AWS account (Known Issue 6)
          securityGroupId: 'sg-0123456789abcdef0', // TODO: Create security group (placeholder!)
          spotInstance: true,              // use cheaper spot pricing
        }
      );

      // 5. Install/configure the streaming software over SSH.
      //    This can take many minutes (Known Issue 1). Errors inside it are
      //    swallowed — see setupSunshine() — so a failed setup doesn't
      //    cancel the launch.
      await this.setupSunshine(launchResult.ipAddress, region, streamingQuality);

      // 6. Record the new machine in our database.
      //    NOW() = the database's current time. RETURNING * gives back the
      //    saved row so we can return it without a second query.
      //    Note: launchResult.ipAddress is NOT saved (Known Issue 2).
      const machineId = uuidv4();
      const insertResult = await query(
        `INSERT INTO machines (
          id, user_id, provider, region, instance_type, instance_id,
          status, cost_per_hour, streaming_quality, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        RETURNING *`,
        [
          machineId,
          userId,
          provider,
          region,
          instanceType,
          launchResult.instanceId,
          'running',
          launchResult.costPerHour,
          normalizedQuality,
        ]
      );

      return insertResult.rows[0];
    } catch (error) {
      // Log here (so it appears in Railway logs with context), then re-throw
      // so the route can send the user an error response.
      console.error('Launch machine error:', error);
      throw error;
    }
  }

  /**
   * Power a machine off, optionally taking a snapshot first.
   *
   * @param snapshot true (default) = back up the games disk before stopping
   */
  static async stopMachine(
    machineId: string,
    userId: string,
    snapshot: boolean = true
  ): Promise<void> {
    try {
      // 1. Load the machine (ownership enforced by the user_id filter).
      const machineResult = await query(
        'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
        [machineId, userId]
      );

      if (machineResult.rows.length === 0) {
        throw new Error('Machine not found');
      }

      const machine = machineResult.rows[0];

      // 2. Snapshot first, if asked. Wrapped in its OWN try/catch so that a
      //    failed snapshot is logged but doesn't prevent the stop — stopping
      //    matters more, because a running machine keeps costing money.
      //    ⚠️ See Known Issue 3: the snapshot id isn't saved on the machine.
      if (snapshot) {
        try {
          console.log('Creating game library snapshot...');
          const snapshotMeta = await SnapshotService.createSnapshot({
            machineId,
            userId,
            paths: ['/mnt/games'],
            description: `Auto-snapshot from ${machine.provider} ${machine.region}`,
          });

          console.log(`Snapshot created: ${snapshotMeta.id}`);
        } catch (error) {
          console.error('Snapshot creation failed:', error);
          // Non-blocking: continue with stop even if snapshot fails
        }
      }

      // 3. Ask the cloud to power it off.
      const credsResult = await query(
        'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
        [userId, machine.provider]
      );

      const credentials = JSON.parse(credsResult.rows[0].encrypted_data);
      const cloudProvider = getProvider(machine.provider, credentials);

      await cloudProvider.stopInstance(machine.instance_id);

      // 4. Record the new state.
      await query(
        'UPDATE machines SET status = $1 WHERE id = $2',
        ['stopped', machineId]
      );
    } catch (error) {
      console.error('Stop machine error:', error);
      throw error;
    }
  }

  /**
   * Power a stopped machine back on, and note when it was started.
   */
  static async startMachine(machineId: string, userId: string): Promise<void> {
    try {
      const machineResult = await query(
        'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
        [machineId, userId]
      );

      if (machineResult.rows.length === 0) {
        throw new Error('Machine not found');
      }

      const machine = machineResult.rows[0];

      const credsResult = await query(
        'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
        [userId, machine.provider]
      );

      const credentials = JSON.parse(credsResult.rows[0].encrypted_data);
      const cloudProvider = getProvider(machine.provider, credentials);

      await cloudProvider.startInstance(machine.instance_id);

      await query(
        'UPDATE machines SET status = $1, last_started = NOW() WHERE id = $2',
        ['running', machineId]
      );
    } catch (error) {
      console.error('Start machine error:', error);
      throw error;
    }
  }

  /**
   * Move a machine to another region or cloud.
   *
   * The idea: you can't "move" a VM, but you can copy its DISK. So:
   *   snapshot the disk -> restore the snapshot as a new machine in the
   *   target location -> record the new machine -> destroy the old one.
   *
   * ⚠️ Depends on machines.snapshot_id being set (Known Issue 3) and on
   *    restoreFromSnapshot, which is incomplete for AWS and unimplemented
   *    elsewhere — so migration doesn't work end-to-end yet.
   */
  static async migrateMachine(
    machineId: string,
    userId: string,
    targetProvider: string,
    targetRegion: string
  ): Promise<Machine> {
    try {
      // 1. The machine being moved.
      const currentMachineResult = await query(
        'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
        [machineId, userId]
      );

      const currentMachine = currentMachineResult.rows[0];

      // 2. Reuse the machine's latest snapshot if it has one; otherwise stop
      //    it (which snapshots it) and re-read the machine to pick up the
      //    snapshot id. `let` because snapshotId may be reassigned.
      let snapshotId = currentMachine.snapshot_id;
      if (!snapshotId) {
        await this.stopMachine(machineId, userId, true);
        const updatedMachine = await query(
          'SELECT snapshot_id FROM machines WHERE id = $1',
          [machineId]
        );
        snapshotId = updatedMachine.rows[0].snapshot_id; // ⚠️ still null — Known Issue 3
      }

      // 3. The snapshot's details (we need the CLOUD's id for it).
      const snapshotResult = await query(
        'SELECT * FROM snapshots WHERE id = $1',
        [snapshotId]
      );

      const snapshot = snapshotResult.rows[0];

      // 4. Credentials for the DESTINATION cloud.
      const targetCredsResult = await query(
        'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
        [userId, targetProvider]
      );

      if (targetCredsResult.rows.length === 0) {
        throw new Error(`No credentials for target provider: ${targetProvider}`);
      }

      const targetCredentials = JSON.parse(targetCredsResult.rows[0].encrypted_data);
      const targetCloudProvider = getProvider(targetProvider, targetCredentials);

      // 5. Create the new machine from the snapshot.
      console.log(`Restoring snapshot to ${targetProvider} ${targetRegion}...`);
      const restoreResult = await targetCloudProvider.restoreFromSnapshot(
        snapshot.snapshot_provider_id,
        { region: targetRegion, instanceType: currentMachine.instance_type }
      );

      // 6. Record the new machine (a fresh id; the old record is removed below).
      const newMachineId = uuidv4();
      const insertResult = await query(
        `INSERT INTO machines (
          id, user_id, provider, region, instance_type, instance_id,
          status, cost_per_hour, snapshot_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        RETURNING *`,
        [
          newMachineId,
          userId,
          targetProvider,
          targetRegion,
          currentMachine.instance_type,
          restoreResult.instanceId,
          'running',
          currentMachine.cost_per_hour, // copied from the old machine; the new region's price may differ
          snapshotId,
        ]
      );

      // 7. Destroy the old machine at its (source) cloud.
      const sourceCredsResult = await query(
        'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
        [userId, currentMachine.provider]
      );

      const sourceCredentials = JSON.parse(sourceCredsResult.rows[0].encrypted_data);
      const sourceCloudProvider = getProvider(currentMachine.provider, sourceCredentials);
      await sourceCloudProvider.terminateInstance(currentMachine.instance_id);

      // 8. Remove the old machine's record.
      await query('DELETE FROM machines WHERE id = $1', [machineId]);

      return insertResult.rows[0];
    } catch (error) {
      console.error('Migrate machine error:', error);
      throw error;
    }
  }

  /**
   * Change a machine's streaming quality preset, and keep an audit trail.
   * If the machine is running, also tries to push the new settings to its
   * streaming software straight away.
   */
  static async updateStreamingQuality(
    machineId: string,
    userId: string,
    newQuality: string
  ): Promise<Machine> {
    try {
      const validQualities = ['budget', 'good', 'high', 'ultra'];
      const normalizedQuality = newQuality.toLowerCase();
      if (!validQualities.includes(normalizedQuality)) {
        throw new Error(
          `Invalid streaming quality: ${newQuality}. Must be one of: ${validQualities.join(', ')}`
        );
      }

      // Load the machine: confirms ownership and tells us the OLD quality
      // (for the audit record).
      const machineResult = await query(
        'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
        [machineId, userId]
      );

      if (machineResult.rows.length === 0) {
        throw new Error('Machine not found');
      }

      const machine = machineResult.rows[0];
      const oldQuality = machine.streaming_quality || 'high';

      // If it's running, reconfigure Sunshine over SSH. Best-effort: failures
      // are logged but don't stop the database update.
      if (machine.status === 'running') {
        try {
          const credsResult = await query(
            'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
            [userId, machine.provider]
          );

          const credentials = JSON.parse(credsResult.rows[0].encrypted_data);
          // Created but not actually used below.
          const cloudProvider = getProvider(machine.provider, credentials);

          // ⚠️ machine.ip_address is always undefined (Known Issue 2), so this
          // SSH attempt can't reach the machine yet.
          const setup = new CloudyPadSetup(
            machine.ip_address,
            normalizedQuality,
            machine.region
          );

          // configureSunshine is marked `private` in CloudyPadSetup;
          // `(setup as any)` bypasses TypeScript's access check to call it.
          // It works at runtime, but it's a shortcut — making the method
          // public would be cleaner.
          await (setup as any).configureSunshine();
          console.log(
            `[MachineService] Updated streaming quality to ${normalizedQuality} on ${machineId}`
          );
        } catch (error) {
          console.error('Failed to apply quality settings to running instance:', error);
          // Continue with database update even if SSH fails - user can retry
        }
      }

      // Save the new preset.
      const updateResult = await query(
        'UPDATE machines SET streaming_quality = $1 WHERE id = $2 RETURNING *',
        [normalizedQuality, machineId]
      );

      // Audit trail: who changed what, from what, to what, and why.
      await query(
        `INSERT INTO quality_updates (machine_id, user_id, old_quality, new_quality, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          machineId,
          userId,
          oldQuality,
          normalizedQuality,
          'User-initiated quality update',
        ]
      );

      console.log(
        `[MachineService] Quality updated for ${machineId}: ${oldQuality} -> ${normalizedQuality}`
      );

      return updateResult.rows[0];
    } catch (error) {
      console.error('Update streaming quality error:', error);
      throw error;
    }
  }

  /**
   * Destroy a machine at the cloud, then delete it (and its snapshot
   * records) from our database.
   * Note: this deletes our snapshot RECORDS but not the snapshots stored at
   * the cloud provider — those keep costing money until deleted there.
   */
  static async deleteMachine(machineId: string, userId: string): Promise<void> {
    try {
      const machineResult = await query(
        'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
        [machineId, userId]
      );

      if (machineResult.rows.length === 0) {
        throw new Error('Machine not found');
      }

      const machine = machineResult.rows[0];

      const credsResult = await query(
        'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
        [userId, machine.provider]
      );

      const credentials = JSON.parse(credsResult.rows[0].encrypted_data);
      const cloudProvider = getProvider(machine.provider, credentials);

      // Destroy at the cloud FIRST: if that fails, we keep our record so the
      // machine isn't forgotten while still running (and billing).
      await cloudProvider.terminateInstance(machine.instance_id);

      await query('DELETE FROM snapshots WHERE machine_id = $1', [machineId]);

      await query('DELETE FROM machines WHERE id = $1', [machineId]);
    } catch (error) {
      console.error('Delete machine error:', error);
      throw error;
    }
  }

  /**
   * Install and configure the streaming stack on a fresh machine using
   * CloudyPadSetup (src/utils/CloudyPadSetup.ts), which connects over SSH.
   *
   * Deliberately NEVER throws: if setup fails, the machine still exists and
   * is recorded, and the user can troubleshoot or retry. Swallowing the
   * error here is a conscious choice — just be aware that a "successful"
   * launch can therefore have a machine without working streaming.
   * Note: no progress callback is passed to CloudyPadSetup, so nothing is
   * written to setup_status for the frontend's progress bar yet.
   */
  private static async setupSunshine(
    ipAddress: string,
    region: string,
    quality: string
  ): Promise<void> {
    try {
      console.log(`Setting up Sunshine on ${ipAddress}...`);

      const setup = new CloudyPadSetup(ipAddress, quality, region);

      // Runs every stage in order: wait for SSH, GPU drivers, CloudyPad,
      // Sunshine config, game launchers, start the service.
      const result = await setup.setup();

      console.log(`Sunshine setup complete: ${result.sunshineUrl}`);
      console.log(`Streaming is ready at: ${result.sunshineUrl}`);
    } catch (error) {
      console.error('Sunshine setup error:', error);
      // Don't fail the whole launch if setup has issues
      // User can retry setup manually or access instance directly
      console.log('Note: Setup errors are non-blocking - user can troubleshoot manually');
    }
  }
}
