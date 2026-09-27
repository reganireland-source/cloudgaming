import { CloudProvider, ProviderConfig, LaunchOptions, SnapshotInfo } from './Provider';
import { RegionData } from '../types';

/**
 * ============================================================================
 * src/providers/AzureProvider.ts — MICROSOFT AZURE (PLACEHOLDER, NOT YET IMPLEMENTED)
 * ============================================================================
 *
 * WHAT THIS IS
 * ------------
 * The Azure version of the CloudProvider contract defined in Provider.ts.
 * It exists so the rest of the app can already treat Azure as a supported
 * cloud (it appears in menus, cost comparisons and the status lights), but
 * the actual cloud operations are NOT built yet.
 *
 * CURRENT BEHAVIOUR
 * -----------------
 * Almost every method immediately does `throw new Error('Not implemented')`.
 * Anything that tries to launch/stop/snapshot a Azure machine will fail
 * with that error. The only working method is getEgressCostPerGb(), which
 * returns a typical published price.
 *
 * Each method has an explicit return type (e.g. Promise<{ instanceId: ... }>)
 * even though it only throws. That's required: without it TypeScript infers
 * the wrong return type and complains the class doesn't match the contract.
 *
 * HOW TO IMPLEMENT IT LATER
 * -------------------------
 * Use AWSProvider.ts as the worked example. For Azure you'd use
 * @azure/arm-compute and @azure/identity, create the SDK client in the constructor from
 * `credentials`, and fill in each method — e.g. launchInstance would create
 * Standard_NV6 (NVIDIA GPU VMs), and createSnapshot would use Azure Blob/managed-disk snapshots. What every method must do
 * is described next to its declaration in Provider.ts.
 * ============================================================================
 */
export class AzureProvider extends CloudProvider {
  name = 'azure' as const;

  // `credentials` = this user's saved login details for the cloud.
  // `super()` runs the parent class's constructor — required first thing
  // in a subclass constructor.
  constructor(credentials: any) {
    super();
    // Initialize Azure SDK
  }

  async launchInstance(
    config: ProviderConfig,
    options: LaunchOptions
  ): Promise<{ instanceId: string; ipAddress: string; costPerHour: number }> {
    throw new Error('Not implemented');
  }

  async stopInstance(instanceId: string): Promise<void> {
    throw new Error('Not implemented');
  }

  async startInstance(instanceId: string): Promise<void> {
    throw new Error('Not implemented');
  }

  async terminateInstance(instanceId: string): Promise<void> {
    throw new Error('Not implemented');
  }

  async getInstanceStatus(instanceId: string): Promise<{
    status: 'running' | 'stopped' | 'terminated' | 'unknown';
    ipAddress?: string;
  }> {
    throw new Error('Not implemented');
  }

  async createSnapshot(
    instanceId: string,
    diskPath: string
  ): Promise<{ snapshotId: string; sizeGb: number }> {
    throw new Error('Not implemented');
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotInfo> {
    throw new Error('Not implemented');
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    throw new Error('Not implemented');
  }

  async restoreFromSnapshot(
    snapshotId: string,
    config: ProviderConfig
  ): Promise<{ instanceId: string; ipAddress: string }> {
    throw new Error('Not implemented');
  }

  async replicateSnapshot(
    sourceSnapshotId: string,
    sourceProvider: string,
    sourceRegion: string,
    targetRegion: string
  ): Promise<{ snapshotId: string }> {
    throw new Error('Not implemented');
  }

  async getRegions(): Promise<RegionData[]> {
    throw new Error('Not implemented');
  }

  async getInstanceCost(
    region: string,
    instanceType: string,
    spot?: boolean
  ): Promise<{ onDemandPrice: number; spotPrice?: number }> {
    throw new Error('Not implemented');
  }

  async getEgressCostPerGb(region: string): Promise<number> {
    // Azure typically charges $0.083/GB
    return 0.083;
  }

  async queryCosts(
    userId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{ computeCost: number; egressCost: number; storageCost: number }> {
    throw new Error('Not implemented');
  }

  async validateCredentials(): Promise<boolean> {
    throw new Error('Not implemented');
  }
}
