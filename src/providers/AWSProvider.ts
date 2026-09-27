import { CloudProvider, ProviderConfig, LaunchOptions, SnapshotInfo } from './Provider';
import { RegionData } from '../types';

/**
 * AWS Provider implementation
 * Uses AWS SDK v2 for now (v3 is more modular but v2 is simpler for MVP)
 */
export class AWSProvider extends CloudProvider {
  name = 'aws' as const;
  private ec2: any;
  private costExplorer: any;

  constructor(credentials: any) {
    super();
    // Initialize AWS SDK with credentials
    // This will be implemented with proper AWS SDK setup
    // For MVP, use environment variables or assume role
  }

  async launchInstance(config: ProviderConfig, options: LaunchOptions) {
    // TODO: Implement AWS instance launch
    throw new Error('Not implemented');
  }

  async stopInstance(instanceId: string): Promise<void> {
    // TODO: Implement
    throw new Error('Not implemented');
  }

  async startInstance(instanceId: string): Promise<void> {
    // TODO: Implement
    throw new Error('Not implemented');
  }

  async terminateInstance(instanceId: string): Promise<void> {
    // TODO: Implement
    throw new Error('Not implemented');
  }

  async getInstanceStatus(instanceId: string) {
    // TODO: Implement
    throw new Error('Not implemented');
  }

  async createSnapshot(instanceId: string, diskPath: string) {
    // TODO: Implement EBS snapshot
    throw new Error('Not implemented');
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotInfo> {
    // TODO: Implement
    throw new Error('Not implemented');
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    // TODO: Implement
    throw new Error('Not implemented');
  }

  async restoreFromSnapshot(snapshotId: string, config: ProviderConfig) {
    // TODO: Implement
    throw new Error('Not implemented');
  }

  async getRegions(): Promise<RegionData[]> {
    // TODO: Query EC2 pricing API
    throw new Error('Not implemented');
  }

  async getInstanceCost(
    region: string,
    instanceType: string,
    spot?: boolean
  ): Promise<{ onDemandPrice: number; spotPrice?: number }> {
    // TODO: Query EC2 pricing
    throw new Error('Not implemented');
  }

  async getEgressCostPerGb(region: string): Promise<number> {
    // AWS typically charges $0.09-0.12/GB depending on region
    const egressRates: Record<string, number> = {
      'ap-southeast-1': 0.12, // Singapore
      'ap-northeast-1': 0.12, // Tokyo
      'ap-southeast-2': 0.12, // Sydney
      'us-east-1': 0.09,
    };
    return egressRates[region] || 0.12;
  }

  async queryCosts(userId: string, startDate: Date, endDate: Date) {
    // TODO: Query AWS Cost Explorer API
    throw new Error('Not implemented');
  }

  async validateCredentials(): Promise<boolean> {
    // TODO: Verify AWS credentials work
    throw new Error('Not implemented');
  }
}
