import { CloudProvider, ProviderConfig, LaunchOptions, SnapshotInfo } from './Provider';
import { RegionData } from '../types';

/**
 * Google Cloud Platform Provider implementation
 */
export class GCPProvider extends CloudProvider {
  name = 'gcp' as const;

  constructor(credentials: any) {
    super();
    // Initialize GCP SDK
  }

  async launchInstance(config: ProviderConfig, options: LaunchOptions) {
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

  async getInstanceStatus(instanceId: string) {
    throw new Error('Not implemented');
  }

  async createSnapshot(instanceId: string, diskPath: string) {
    throw new Error('Not implemented');
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotInfo> {
    throw new Error('Not implemented');
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    throw new Error('Not implemented');
  }

  async restoreFromSnapshot(snapshotId: string, config: ProviderConfig) {
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
    // GCP typically charges $0.12/GB
    return 0.12;
  }

  async queryCosts(userId: string, startDate: Date, endDate: Date) {
    throw new Error('Not implemented');
  }

  async validateCredentials(): Promise<boolean> {
    throw new Error('Not implemented');
  }
}
