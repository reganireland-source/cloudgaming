import { CloudProvider, ProviderConfig, LaunchOptions, SnapshotInfo } from './Provider';
import { RegionData } from '../types';

/**
 * Azure Provider implementation
 */
export class AzureProvider extends CloudProvider {
  name = 'azure' as const;

  constructor(credentials: any) {
    super();
    // Initialize Azure SDK
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
    // Azure typically charges $0.083/GB
    return 0.083;
  }

  async queryCosts(userId: string, startDate: Date, endDate: Date) {
    throw new Error('Not implemented');
  }

  async validateCredentials(): Promise<boolean> {
    throw new Error('Not implemented');
  }
}
