import { query } from '../config/database';
import { getProvider } from '../providers';
import { v4 as uuidv4 } from 'uuid';

interface SnapshotConfig {
  machineId: string;
  userId: string;
  paths?: string[]; // Paths to snapshot (default: /mnt/games)
  description?: string;
}

interface SnapshotMeta {
  id: string;
  machineId: string;
  userId: string;
  sourceProvider: string;
  sourceRegion: string;
  snapshots: {
    [provider: string]: {
      id: string;
      region: string;
      sizeGb: number;
      createdAt: string;
    };
  };
  createdAt: string;
  totalSizeGb: number;
  estimatedMonthlyCostUsd: number;
}

export class SnapshotService {
  /**
   * Create snapshot on current provider and optionally replicate to other providers
   */
  static async createSnapshot(config: SnapshotConfig): Promise<SnapshotMeta> {
    const { machineId, userId, paths = ['/mnt/games'], description } = config;

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

      // 2. Get cloud credentials for source provider
      const credsResult = await query(
        'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
        [userId, machine.provider]
      );

      const credentials = JSON.parse(credsResult.rows[0].encrypted_data);
      const cloudProvider = getProvider(machine.provider, credentials);

      // 3. Create snapshot on source provider
      console.log(`[SnapshotService] Creating snapshot on ${machine.provider}...`);
      const snapshotResult = await cloudProvider.createSnapshot(
        machine.instance_id,
        paths.join(',')
      );

      // 4. Save snapshot metadata
      const snapshotId = uuidv4();
      const snapshots: Record<string, any> = {};
      snapshots[machine.provider] = {
        id: snapshotResult.snapshotId,
        region: machine.region,
        sizeGb: snapshotResult.sizeGb,
        createdAt: new Date().toISOString(),
      };

      await query(
        `INSERT INTO snapshots (
          id, machine_id, user_id, provider, region, snapshot_provider_id,
          disk_size_gb, description, snapshot_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          snapshotId,
          machineId,
          userId,
          machine.provider,
          machine.region,
          snapshotResult.snapshotId,
          snapshotResult.sizeGb,
          description || 'Auto-snapshot',
          JSON.stringify(snapshots),
        ]
      );

      console.log(`[SnapshotService] Snapshot created: ${snapshotId}`);

      return {
        id: snapshotId,
        machineId,
        userId,
        sourceProvider: machine.provider,
        sourceRegion: machine.region,
        snapshots,
        createdAt: new Date().toISOString(),
        totalSizeGb: snapshotResult.sizeGb,
        estimatedMonthlyCostUsd: this.estimateSnapshotCost(
          snapshotResult.sizeGb,
          machine.provider
        ),
      };
    } catch (error) {
      console.error('Snapshot creation error:', error);
      throw error;
    }
  }

  /**
   * Copy existing snapshot to another provider/region
   */
  static async replicateSnapshot(
    snapshotId: string,
    userId: string,
    targetProvider: string,
    targetRegion: string
  ): Promise<SnapshotMeta> {
    try {
      // 1. Get existing snapshot
      const snapshotResult = await query(
        'SELECT * FROM snapshots WHERE id = $1 AND user_id = $2',
        [snapshotId, userId]
      );

      if (snapshotResult.rows.length === 0) {
        throw new Error('Snapshot not found');
      }

      const snapshot = snapshotResult.rows[0];
      const snapshots = snapshot.snapshot_data
        ? JSON.parse(snapshot.snapshot_data)
        : {};

      // 2. Check if already replicated to target
      if (snapshots[targetProvider]?.region === targetRegion) {
        console.log(
          `[SnapshotService] Snapshot already exists on ${targetProvider} in ${targetRegion}`
        );
        return this.getSnapshotMetadata(snapshotId, userId);
      }

      // 3. Get credentials for both source and target
      const sourceCredsResult = await query(
        'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
        [userId, snapshot.provider]
      );

      const targetCredsResult = await query(
        'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
        [userId, targetProvider]
      );

      const sourceCredentials = JSON.parse(sourceCredsResult.rows[0].encrypted_data);
      const targetCredentials = JSON.parse(targetCredsResult.rows[0].encrypted_data);

      const sourceProvider = getProvider(snapshot.provider, sourceCredentials);
      const targetCloudProvider = getProvider(targetProvider, targetCredentials);

      // 4. Copy snapshot (provider-specific logic)
      console.log(
        `[SnapshotService] Replicating snapshot from ${snapshot.provider}:${snapshot.region} to ${targetProvider}:${targetRegion}...`
      );

      const replicateResult = await targetCloudProvider.replicateSnapshot(
        snapshot.snapshot_provider_id,
        snapshot.provider,
        snapshot.region,
        targetRegion
      );

      // 5. Update snapshot metadata
      snapshots[targetProvider] = {
        id: replicateResult.snapshotId,
        region: targetRegion,
        sizeGb: snapshot.disk_size_gb,
        createdAt: new Date().toISOString(),
      };

      await query(
        'UPDATE snapshots SET snapshot_data = $1, updated_at = NOW() WHERE id = $2',
        [JSON.stringify(snapshots), snapshotId]
      );

      console.log(`[SnapshotService] Snapshot replicated to ${targetProvider}`);

      return this.getSnapshotMetadata(snapshotId, userId);
    } catch (error) {
      console.error('Snapshot replication error:', error);
      throw error;
    }
  }

  /**
   * Get full snapshot metadata including cross-provider replicas
   */
  static async getSnapshotMetadata(
    snapshotId: string,
    userId: string
  ): Promise<SnapshotMeta> {
    try {
      const result = await query(
        'SELECT * FROM snapshots WHERE id = $1 AND user_id = $2',
        [snapshotId, userId]
      );

      if (result.rows.length === 0) {
        throw new Error('Snapshot not found');
      }

      const snapshot = result.rows[0];
      const snapshots = snapshot.snapshot_data
        ? JSON.parse(snapshot.snapshot_data)
        : {};

      // Calculate total size and cost
      let totalSizeGb = 0;
      let totalMonthlyCost = 0;

      Object.entries(snapshots).forEach(([provider, data]: any) => {
        totalSizeGb += data.sizeGb;
        totalMonthlyCost += this.estimateSnapshotCost(data.sizeGb, provider);
      });

      return {
        id: snapshotId,
        machineId: snapshot.machine_id,
        userId,
        sourceProvider: snapshot.provider,
        sourceRegion: snapshot.region,
        snapshots,
        createdAt: snapshot.created_at,
        totalSizeGb,
        estimatedMonthlyCostUsd: totalMonthlyCost,
      };
    } catch (error) {
      console.error('Get snapshot metadata error:', error);
      throw error;
    }
  }

  /**
   * List all snapshots for a user with cost breakdown
   */
  static async listSnapshots(userId: string): Promise<SnapshotMeta[]> {
    try {
      const result = await query(
        'SELECT * FROM snapshots WHERE user_id = $1 ORDER BY created_at DESC',
        [userId]
      );

      const snapshots: SnapshotMeta[] = [];

      for (const snapshot of result.rows) {
        const snapshotData = snapshot.snapshot_data
          ? JSON.parse(snapshot.snapshot_data)
          : {};

        let totalSizeGb = 0;
        let totalMonthlyCost = 0;

        Object.entries(snapshotData).forEach(([provider, data]: any) => {
          totalSizeGb += data.sizeGb;
          totalMonthlyCost += this.estimateSnapshotCost(data.sizeGb, provider);
        });

        snapshots.push({
          id: snapshot.id,
          machineId: snapshot.machine_id,
          userId,
          sourceProvider: snapshot.provider,
          sourceRegion: snapshot.region,
          snapshots: snapshotData,
          createdAt: snapshot.created_at,
          totalSizeGb,
          estimatedMonthlyCostUsd: totalMonthlyCost,
        });
      }

      return snapshots;
    } catch (error) {
      console.error('List snapshots error:', error);
      throw error;
    }
  }

  /**
   * Delete snapshot and all replicas
   */
  static async deleteSnapshot(snapshotId: string, userId: string): Promise<void> {
    try {
      const snapshotResult = await query(
        'SELECT * FROM snapshots WHERE id = $1 AND user_id = $2',
        [snapshotId, userId]
      );

      if (snapshotResult.rows.length === 0) {
        throw new Error('Snapshot not found');
      }

      const snapshot = snapshotResult.rows[0];
      const snapshots = snapshot.snapshot_data
        ? JSON.parse(snapshot.snapshot_data)
        : {};

      // Delete from each provider
      for (const [provider, data] of Object.entries(snapshots)) {
        try {
          const credsResult = await query(
            'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
            [userId, provider]
          );

          if (credsResult.rows.length > 0) {
            const credentials = JSON.parse(credsResult.rows[0].encrypted_data);
            const cloudProvider = getProvider(provider, credentials);
            await cloudProvider.deleteSnapshot((data as any).id);
            console.log(`[SnapshotService] Deleted snapshot from ${provider}`);
          }
        } catch (error) {
          console.error(`Failed to delete snapshot from ${provider}:`, error);
        }
      }

      // Delete metadata
      await query('DELETE FROM snapshots WHERE id = $1', [snapshotId]);
      console.log(`[SnapshotService] Snapshot metadata deleted`);
    } catch (error) {
      console.error('Delete snapshot error:', error);
      throw error;
    }
  }

  /**
   * Estimate monthly storage cost based on provider and size
   * Rough estimates: AWS $0.05/GB/month, Azure $0.05/GB/month, GCP $0.026/GB/month
   */
  private static estimateSnapshotCost(
    sizeGb: number,
    provider: string
  ): number {
    const costPerGb: Record<string, number> = {
      aws: 0.05,
      azure: 0.05,
      gcp: 0.026,
    };

    return (costPerGb[provider.toLowerCase()] || 0.05) * sizeGb;
  }
}
