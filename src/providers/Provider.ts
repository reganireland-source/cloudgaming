import { Machine, RegionData, Snapshot } from '../types';

export interface ProviderConfig {
  region: string;
  instanceType: string;
}

export interface LaunchOptions {
  imageId: string;
  keyName: string;
  securityGroupId: string;
  spotInstance?: boolean;
}

export interface SnapshotInfo {
  id: string;
  sizeGb: number;
  state: string;
}

export abstract class CloudProvider {
  abstract name: 'aws' | 'azure' | 'gcp' | 'oracle';

  /**
   * Launch a new instance
   */
  abstract launchInstance(
    config: ProviderConfig,
    options: LaunchOptions
  ): Promise<{ instanceId: string; ipAddress: string; costPerHour: number }>;

  /**
   * Stop a running instance (don't terminate)
   */
  abstract stopInstance(instanceId: string): Promise<void>;

  /**
   * Start a stopped instance
   */
  abstract startInstance(instanceId: string): Promise<void>;

  /**
   * Terminate an instance and clean up
   */
  abstract terminateInstance(instanceId: string): Promise<void>;

  /**
   * Get current instance status
   */
  abstract getInstanceStatus(instanceId: string): Promise<{
    status: 'running' | 'stopped' | 'terminated' | 'unknown';
    ipAddress?: string;
  }>;

  /**
   * Create a snapshot of an instance's disk
   */
  abstract createSnapshot(
    instanceId: string,
    diskPath: string
  ): Promise<{ snapshotId: string; sizeGb: number }>;

  /**
   * Get snapshot info
   */
  abstract getSnapshot(snapshotId: string): Promise<SnapshotInfo>;

  /**
   * Delete a snapshot
   */
  abstract deleteSnapshot(snapshotId: string): Promise<void>;

  /**
   * Restore a snapshot to a new instance
   */
  abstract restoreFromSnapshot(
    snapshotId: string,
    config: ProviderConfig
  ): Promise<{ instanceId: string; ipAddress: string }>;

  /**
   * Get available regions and their costs
   */
  abstract getRegions(): Promise<RegionData[]>;

  /**
   * Get cost for a specific instance type in a region
   */
  abstract getInstanceCost(
    region: string,
    instanceType: string,
    spot?: boolean
  ): Promise<{ onDemandPrice: number; spotPrice?: number }>;

  /**
   * Get egress cost for a region
   */
  abstract getEgressCostPerGb(region: string): Promise<number>;

  /**
   * Query recent costs from the provider's billing API
   */
  abstract queryCosts(userId: string, startDate: Date, endDate: Date): Promise<{
    computeCost: number;
    egressCost: number;
    storageCost: number;
  }>;

  /**
   * Validate credentials
   */
  abstract validateCredentials(): Promise<boolean>;
}
