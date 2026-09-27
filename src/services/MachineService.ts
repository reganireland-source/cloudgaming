import { query } from '../config/database';
import { getProvider } from '../providers';
import { Machine, Snapshot } from '../types';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { CloudyPadSetup } from '../utils/CloudyPadSetup';
import { env } from '../config/env';

/**
 * MachineService handles machine lifecycle orchestration
 */
export class MachineService {
  /**
   * Launch a new gaming machine
   */
  static async launchMachine(
    userId: string,
    provider: string,
    region: string,
    instanceType: string,
    gameTitle: string,
    streamingQuality: string
  ): Promise<Machine> {
    try {
      // 1. Get cloud credentials for this provider
      const credsResult = await query(
        'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
        [userId, provider]
      );

      if (credsResult.rows.length === 0) {
        throw new Error(`No credentials found for provider: ${provider}`);
      }

      const encryptedCreds = credsResult.rows[0].encrypted_data;
      const credentials = JSON.parse(encryptedCreds); // In production, decrypt first

      // 2. Initialize cloud provider
      const cloudProvider = getProvider(provider, credentials);

      // 3. Validate credentials
      const valid = await cloudProvider.validateCredentials();
      if (!valid) {
        throw new Error('Invalid cloud credentials');
      }

      // 4. Launch instance
      console.log(`Launching ${instanceType} in ${region}...`);
      const launchResult = await cloudProvider.launchInstance(
        { region, instanceType },
        {
          imageId: env.CLOUDGAMING_AMI_ID, // From CLOUDGAMING_AMI_ID env var
          keyName: 'cloudgaming-key',
          securityGroupId: 'sg-0123456789abcdef0', // TODO: Create security group
          spotInstance: true,
        }
      );

      // 5. Run Cloudy Pad setup on the instance
      await this.setupSunshine(launchResult.ipAddress, region, streamingQuality);

      // 6. Save machine to database
      const machineId = uuidv4();
      const insertResult = await query(
        `INSERT INTO machines (
          id, user_id, provider, region, instance_type, instance_id,
          status, cost_per_hour, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
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
        ]
      );

      return insertResult.rows[0];
    } catch (error) {
      console.error('Launch machine error:', error);
      throw error;
    }
  }

  /**
   * Stop a machine (creates snapshot if requested)
   */
  static async stopMachine(
    machineId: string,
    userId: string,
    snapshot: boolean = true
  ): Promise<void> {
    try {
      // 1. Get machine info
      const machineResult = await query(
        'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
        [machineId, userId]
      );

      if (machineResult.rows.length === 0) {
        throw new Error('Machine not found');
      }

      const machine = machineResult.rows[0];

      // 2. Get cloud provider
      const credsResult = await query(
        'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
        [userId, machine.provider]
      );

      const credentials = JSON.parse(credsResult.rows[0].encrypted_data);
      const cloudProvider = getProvider(machine.provider, credentials);

      // 3. Create snapshot if requested
      if (snapshot) {
        console.log('Creating game library snapshot...');
        const snapResult = await cloudProvider.createSnapshot(machine.instance_id, '/mnt/games');

        const snapshotId = uuidv4();
        await query(
          `INSERT INTO snapshots (
            id, machine_id, user_id, provider, region, snapshot_provider_id, disk_size_gb
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [snapshotId, machineId, userId, machine.provider, machine.region, snapResult.snapshotId, snapResult.sizeGb]
        );

        // Update machine's snapshot reference
        await query(
          'UPDATE machines SET snapshot_id = $1 WHERE id = $2',
          [snapshotId, machineId]
        );
      }

      // 4. Stop instance
      await cloudProvider.stopInstance(machine.instance_id);

      // 5. Update machine status
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
   * Start a stopped machine
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
   * Migrate machine to a different region/provider
   */
  static async migrateMachine(
    machineId: string,
    userId: string,
    targetProvider: string,
    targetRegion: string
  ): Promise<Machine> {
    try {
      // 1. Get current machine
      const currentMachineResult = await query(
        'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
        [machineId, userId]
      );

      const currentMachine = currentMachineResult.rows[0];

      // 2. Get or create snapshot
      let snapshotId = currentMachine.snapshot_id;
      if (!snapshotId) {
        await this.stopMachine(machineId, userId, true);
        const updatedMachine = await query(
          'SELECT snapshot_id FROM machines WHERE id = $1',
          [machineId]
        );
        snapshotId = updatedMachine.rows[0].snapshot_id;
      }

      // 3. Get snapshot details
      const snapshotResult = await query(
        'SELECT * FROM snapshots WHERE id = $1',
        [snapshotId]
      );

      const snapshot = snapshotResult.rows[0];

      // 4. Get target cloud credentials
      const targetCredsResult = await query(
        'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
        [userId, targetProvider]
      );

      if (targetCredsResult.rows.length === 0) {
        throw new Error(`No credentials for target provider: ${targetProvider}`);
      }

      const targetCredentials = JSON.parse(targetCredsResult.rows[0].encrypted_data);
      const targetCloudProvider = getProvider(targetProvider, targetCredentials);

      // 5. Restore snapshot in target region
      console.log(`Restoring snapshot to ${targetProvider} ${targetRegion}...`);
      const restoreResult = await targetCloudProvider.restoreFromSnapshot(
        snapshot.snapshot_provider_id,
        { region: targetRegion, instanceType: currentMachine.instance_type }
      );

      // 6. Create new machine record
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
          currentMachine.cost_per_hour,
          snapshotId,
        ]
      );

      // 7. Terminate old machine
      const sourceCredsResult = await query(
        'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
        [userId, currentMachine.provider]
      );

      const sourceCredentials = JSON.parse(sourceCredsResult.rows[0].encrypted_data);
      const sourceCloudProvider = getProvider(currentMachine.provider, sourceCredentials);
      await sourceCloudProvider.terminateInstance(currentMachine.instance_id);

      // 8. Delete old machine record
      await query('DELETE FROM machines WHERE id = $1', [machineId]);

      return insertResult.rows[0];
    } catch (error) {
      console.error('Migrate machine error:', error);
      throw error;
    }
  }

  /**
   * Delete/terminate a machine
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

      await cloudProvider.terminateInstance(machine.instance_id);

      // Delete snapshots associated with this machine
      await query('DELETE FROM snapshots WHERE machine_id = $1', [machineId]);

      // Delete machine
      await query('DELETE FROM machines WHERE id = $1', [machineId]);
    } catch (error) {
      console.error('Delete machine error:', error);
      throw error;
    }
  }

  /**
   * Setup Sunshine streaming server via CloudyPad
   * Uses SSH to configure streaming on remote Windows instance
   */
  private static async setupSunshine(
    ipAddress: string,
    region: string,
    quality: string
  ): Promise<void> {
    try {
      console.log(`Setting up Sunshine on ${ipAddress}...`);

      // Initialize CloudyPad setup orchestrator
      const setup = new CloudyPadSetup(ipAddress, quality, region);

      // Run full setup pipeline (drivers, CloudyPad, Sunshine, gaming clients)
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
