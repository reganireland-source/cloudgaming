import { CloudProvider, ProviderConfig, LaunchOptions, SnapshotInfo } from './Provider';
import { RegionData } from '../types';

/**
 * Oracle Cloud Provider implementation
 */
export class OracleProvider extends CloudProvider {
  name = 'oracle' as const;

  constructor(credentials: any) {
    super();
    // Initialize Oracle OCI SDK
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
    // Oracle provides 10TB/month free egress, then free for customers
    // Model as free for MVP
    return 0;
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
