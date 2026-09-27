/**
 * ============================================================================
 * src/services/SnapshotService.ts — CREATE, COPY, LIST AND DELETE BACKUPS
 * ============================================================================
 *
 * A snapshot is a backup of a machine's disk (all its installed games).
 * This service records each snapshot in the `snapshots` table and asks the
 * right cloud provider to do the actual work.
 *
 * ONE SNAPSHOT, SEVERAL COPIES
 * ----------------------------
 * A snapshot can be copied ("replicated") to other regions/clouds. Every
 * copy's details live together in one JSONB column, `snapshot_data`, shaped
 * like:
 *     { "aws": { "id": "snap-0abc", "region": "ap-southeast-1", "sizeGb": 100, "createdAt": "..." },
 *       "gcp": { ... } }
 * JSONB is Postgres's "store a JSON object in a column" type.
 *
 * ⚠️  KNOWN BUGS (real — fix before using snapshots)
 * -------------------------------------------------
 * 1. JSON.parse on an already-parsed value: the `pg` database driver
 *    automatically converts JSONB columns into JavaScript objects. Calling
 *    JSON.parse() on an object turns it into the text "[object Object]" and
 *    throws a SyntaxError. Because snapshot_data defaults to '{}', EVERY
 *    snapshot row hits this — so getSnapshotMetadata, listSnapshots,
 *    replicateSnapshot and deleteSnapshot all fail as soon as any snapshot
 *    exists. Fix: use `snapshot.snapshot_data || {}` without JSON.parse.
 * 2. Copies are keyed by PROVIDER name, so there can only be one "aws" entry.
 *    Copying an AWS snapshot to a second AWS region overwrites the record of
 *    the original. Keying by "provider:region" would fix it.
 * 3. createSnapshot doesn't write the new snapshot's id to
 *    machines.snapshot_id, which MachineService.migrateMachine relies on.
 * 4. credsResult.rows[0] is used without checking it exists.
 * ============================================================================
 */

import { query } from '../config/database';
import { getProvider } from '../providers';
import { v4 as uuidv4 } from 'uuid';

/** Inputs for createSnapshot. `?` = optional. */
interface SnapshotConfig {
  machineId: string;
  userId: string;
  paths?: string[]; // Paths to snapshot (default: /mnt/games) — informational; clouds snapshot whole disks
  description?: string;
}

/** What callers get back: the snapshot plus every copy and a cost estimate. */
interface SnapshotMeta {
  id: string;                    // OUR id for the snapshot
  machineId: string;
  userId: string;
  sourceProvider: string;        // where the original was taken
  sourceRegion: string;
  // `[provider: string]: {...}` = "an object whose keys are provider names
  // and whose values have this shape" (the snapshot_data structure above).
  snapshots: {
    [provider: string]: {
      id: string;                // the CLOUD's id for this copy (e.g. "snap-0abc...")
      region: string;
      sizeGb: number;
      createdAt: string;
    };
  };
  createdAt: string;
  totalSizeGb: number;           // across all copies
  estimatedMonthlyCostUsd: number; // storage cost of all copies together
}

export class SnapshotService {
  /**
   * Back up a machine's disk at its current cloud, and record it.
   * (The "optionally replicate" in the original comment below isn't done
   * here — replication is a separate call to replicateSnapshot.)
   * Create snapshot on current provider and optionally replicate to other providers
   */
  static async createSnapshot(config: SnapshotConfig): Promise<SnapshotMeta> {
    // Unpack the config object, defaulting `paths` if it wasn't given.
    const { machineId, userId, paths = ['/mnt/games'], description } = config;

    try {
      // 1. The machine (and ownership check).
      const machineResult = await query(
        'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
        [machineId, userId]
      );

      if (machineResult.rows.length === 0) {
        throw new Error('Machine not found');
      }

      const machine = machineResult.rows[0];

      // 2. Credentials for the machine's cloud.
      const credsResult = await query(
        'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
        [userId, machine.provider]
      );

      const credentials = JSON.parse(credsResult.rows[0].encrypted_data);
      const cloudProvider = getProvider(machine.provider, credentials);

      // 3. Ask the cloud to take the snapshot. `paths.join(',')` turns
      //    ['/mnt/games'] into the text '/mnt/games'.
      console.log(`[SnapshotService] Creating snapshot on ${machine.provider}...`);
      const snapshotResult = await cloudProvider.createSnapshot(
        machine.instance_id,
        paths.join(',')
      );

      // 4. Build the snapshot_data object with this first copy, then save.
      //    `Record<string, any>` = an object with any string keys.
      const snapshotId = uuidv4();
      const snapshots: Record<string, any> = {};
      snapshots[machine.provider] = {
        id: snapshotResult.snapshotId,
        region: machine.region,
        sizeGb: snapshotResult.sizeGb,
        createdAt: new Date().toISOString(),
      };

      // JSON.stringify turns the object into JSON text for storage.
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
   * Copy an existing snapshot to another region/cloud and record the copy.
   * Copy existing snapshot to another provider/region
   */
  static async replicateSnapshot(
    snapshotId: string,
    userId: string,
    targetProvider: string,
    targetRegion: string
  ): Promise<SnapshotMeta> {
    try {
      // 1. The snapshot (and ownership check).
      const snapshotResult = await query(
        'SELECT * FROM snapshots WHERE id = $1 AND user_id = $2',
        [snapshotId, userId]
      );

      if (snapshotResult.rows.length === 0) {
        throw new Error('Snapshot not found');
      }

      const snapshot = snapshotResult.rows[0];
      // ⚠️ Known Bug 1: snapshot_data is already an object — this throws.
      const snapshots = snapshot.snapshot_data
        ? JSON.parse(snapshot.snapshot_data)
        : {};

      // 2. Nothing to do if that exact copy already exists.
      if (snapshots[targetProvider]?.region === targetRegion) {
        console.log(
          `[SnapshotService] Snapshot already exists on ${targetProvider} in ${targetRegion}`
        );
        return this.getSnapshotMetadata(snapshotId, userId);
      }

      // 3. Credentials for the source cloud (where the snapshot is) and the
      //    target cloud (where the copy will go).
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

      // sourceProvider is created but not used; the TARGET provider does the copy.
      const sourceProvider = getProvider(snapshot.provider, sourceCredentials);
      const targetCloudProvider = getProvider(targetProvider, targetCredentials);

      // 4. Ask the target cloud to pull in a copy.
      console.log(
        `[SnapshotService] Replicating snapshot from ${snapshot.provider}:${snapshot.region} to ${targetProvider}:${targetRegion}...`
      );

      const replicateResult = await targetCloudProvider.replicateSnapshot(
        snapshot.snapshot_provider_id,
        snapshot.provider,
        snapshot.region,
        targetRegion
      );

      // 5. Record the new copy (⚠️ Known Bug 2: replaces any existing entry
      //    for the same provider).
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
   * One snapshot with all its copies, total size and monthly cost.
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
      // ⚠️ Known Bug 1.
      const snapshots = snapshot.snapshot_data
        ? JSON.parse(snapshot.snapshot_data)
        : {};

      // Add up size and cost across every copy. Object.entries turns
      // { aws: {...}, gcp: {...} } into [['aws', {...}], ['gcp', {...}]], and
      // `([provider, data])` unpacks each pair.
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
   * Every snapshot the user owns, newest first, each with size and cost —
   * the same calculation as getSnapshotMetadata, repeated per row.
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
        // ⚠️ Known Bug 1.
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
   * Delete a snapshot: every copy at every cloud first, then our record.
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
      // ⚠️ Known Bug 1.
      const snapshots = snapshot.snapshot_data
        ? JSON.parse(snapshot.snapshot_data)
        : {};

      // Each copy is deleted in its own try/catch, so one failure doesn't
      // stop the others from being deleted. Failures are only logged.
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

      // Remove our record. Note: this happens even if a cloud deletion
      // failed above — that copy would then be orphaned (still billed, but
      // no longer tracked here).
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
   * e.g. a 100 GB AWS snapshot ≈ 100 × $0.05 = $5.00/month.
   * `private` = only used inside this class.
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

    // Unknown providers (e.g. oracle) default to $0.05/GB.
    return (costPerGb[provider.toLowerCase()] || 0.05) * sizeGb;
  }
}
