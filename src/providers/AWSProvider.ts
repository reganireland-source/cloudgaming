import AWS from 'aws-sdk';
import { CloudProvider, ProviderConfig, LaunchOptions, SnapshotInfo } from './Provider';
import { RegionData } from '../types';

/**
 * AWS Provider implementation using AWS SDK v2
 */
export class AWSProvider extends CloudProvider {
  name = 'aws' as const;
  private ec2: AWS.EC2;
  private pricing: AWS.Pricing;
  private costExplorer: AWS.CostExplorer;
  private region: string;

  constructor(credentials: any) {
    super();
    // Initialize AWS services
    // Credentials are decrypted in the service layer and passed here
    this.region = credentials.region || 'ap-southeast-1';

    const awsConfig = {
      region: this.region,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    };

    this.ec2 = new AWS.EC2(awsConfig);
    this.pricing = new AWS.Pricing({ region: 'us-east-1' }); // Pricing API only in US
    this.costExplorer = new AWS.CostExplorer(awsConfig);
  }

  async launchInstance(config: ProviderConfig, options: LaunchOptions) {
    try {
      const params: AWS.EC2.RunInstancesRequest = {
        ImageId: options.imageId,
        InstanceType: config.instanceType as any,
        MinCount: 1,
        MaxCount: 1,
        KeyName: options.keyName,
        SecurityGroupIds: [options.securityGroupId],
        InstanceMarketOptions: options.spotInstance ? {
          MarketType: 'spot',
          SpotOptions: {
            MaxPrice: '0.50', // Will be overridden with actual spot price
            SpotInstanceType: 'persistent',
          },
        } : undefined,
        TagSpecifications: [
          {
            ResourceType: 'instance',
            Tags: [
              { Key: 'Name', Value: `cloudgaming-${Date.now()}` },
              { Key: 'ManagedBy', Value: 'CloudGamingHub' },
            ],
          },
        ],
      };

      const result = await this.ec2.runInstances(params).promise();
      const instance = result.Instances?.[0];

      if (!instance) {
        throw new Error('Failed to create instance');
      }

      // Get on-demand price for this instance type
      const costPerHour = await this.getInstanceCost(config.region, config.instanceType, false);

      return {
        instanceId: instance.InstanceId!,
        ipAddress: instance.PublicIpAddress || instance.PrivateIpAddress || '',
        costPerHour: costPerHour.onDemandPrice,
      };
    } catch (error) {
      console.error('AWS launch error:', error);
      throw new Error(`Failed to launch AWS instance: ${error}`);
    }
  }

  async stopInstance(instanceId: string): Promise<void> {
    try {
      await this.ec2.stopInstances({ InstanceIds: [instanceId] }).promise();
    } catch (error) {
      console.error('AWS stop error:', error);
      throw new Error(`Failed to stop instance: ${error}`);
    }
  }

  async startInstance(instanceId: string): Promise<void> {
    try {
      await this.ec2.startInstances({ InstanceIds: [instanceId] }).promise();
    } catch (error) {
      console.error('AWS start error:', error);
      throw new Error(`Failed to start instance: ${error}`);
    }
  }

  async terminateInstance(instanceId: string): Promise<void> {
    try {
      await this.ec2.terminateInstances({ InstanceIds: [instanceId] }).promise();
    } catch (error) {
      console.error('AWS terminate error:', error);
      throw new Error(`Failed to terminate instance: ${error}`);
    }
  }

  async getInstanceStatus(instanceId: string) {
    try {
      const result = await this.ec2.describeInstances({ InstanceIds: [instanceId] }).promise();
      const instance = result.Reservations?.[0]?.Instances?.[0];

      if (!instance) {
        return { status: 'unknown' as const };
      }

      const stateMap: Record<string, 'running' | 'stopped' | 'terminated' | 'unknown'> = {
        'running': 'running',
        'stopped': 'stopped',
        'terminated': 'terminated',
      };

      return {
        status: stateMap[instance.State?.Name || 'unknown'] || 'unknown',
        ipAddress: instance.PublicIpAddress || instance.PrivateIpAddress,
      };
    } catch (error) {
      console.error('AWS status error:', error);
      return { status: 'unknown' as const };
    }
  }

  async createSnapshot(instanceId: string, diskPath: string) {
    try {
      // Get the EBS volume attached to the instance
      const instanceDesc = await this.ec2.describeInstances({ InstanceIds: [instanceId] }).promise();
      const instance = instanceDesc.Reservations?.[0]?.Instances?.[0];

      if (!instance?.BlockDeviceMappings?.[0]) {
        throw new Error('No EBS volume found');
      }

      const volumeId = instance.BlockDeviceMappings[0].Ebs?.VolumeId;
      if (!volumeId) {
        throw new Error('Failed to get volume ID');
      }

      // Get volume size
      const volumeDesc = await this.ec2.describeVolumes({ VolumeIds: [volumeId] }).promise();
      const sizeGb = volumeDesc.Volumes?.[0]?.Size || 0;

      // Create snapshot
      const snapshot = await this.ec2.createSnapshot({
        VolumeId: volumeId,
        Description: `Snapshot for ${instanceId}`,
        TagSpecifications: [
          {
            ResourceType: 'snapshot',
            Tags: [
              { Key: 'ManagedBy', Value: 'CloudGamingHub' },
              { Key: 'SourceInstance', Value: instanceId },
            ],
          },
        ],
      }).promise();

      return {
        snapshotId: snapshot.SnapshotId!,
        sizeGb,
      };
    } catch (error) {
      console.error('AWS snapshot error:', error);
      throw new Error(`Failed to create snapshot: ${error}`);
    }
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotInfo> {
    try {
      const result = await this.ec2.describeSnapshots({ SnapshotIds: [snapshotId] }).promise();
      const snapshot = result.Snapshots?.[0];

      if (!snapshot) {
        throw new Error('Snapshot not found');
      }

      return {
        id: snapshot.SnapshotId!,
        sizeGb: snapshot.VolumeSize || 0,
        state: snapshot.State || 'unknown',
      };
    } catch (error) {
      console.error('AWS get snapshot error:', error);
      throw new Error(`Failed to get snapshot: ${error}`);
    }
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    try {
      await this.ec2.deleteSnapshot({ SnapshotId: snapshotId }).promise();
    } catch (error) {
      console.error('AWS delete snapshot error:', error);
      throw new Error(`Failed to delete snapshot: ${error}`);
    }
  }

  async restoreFromSnapshot(snapshotId: string, config: ProviderConfig) {
    try {
      // Create volume from snapshot
      const snapshot = await this.getSnapshot(snapshotId);

      const volume = await this.ec2.createVolume({
        SnapshotId: snapshotId,
        AvailabilityZone: `${this.region}a`, // Assume first AZ
        TagSpecifications: [
          {
            ResourceType: 'volume',
            Tags: [
              { Key: 'ManagedBy', Value: 'CloudGamingHub' },
              { Key: 'RestoredFrom', Value: snapshotId },
            ],
          },
        ],
      }).promise();

      // Wait for volume to be available
      await this.ec2.waitFor('volumeAvailable', { VolumeIds: [volume.VolumeId!] }).promise();

      // Launch instance
      const launchResult = await this.launchInstance(config, {
        imageId: '', // Will be ignored; we'll attach the volume instead
        keyName: '',
        securityGroupId: '',
      });

      // TODO: Attach the restored volume to the instance
      // This is a multi-step process that requires careful handling

      return {
        instanceId: launchResult.instanceId,
        ipAddress: launchResult.ipAddress,
      };
    } catch (error) {
      console.error('AWS restore error:', error);
      throw new Error(`Failed to restore from snapshot: ${error}`);
    }
  }

  async getRegions(): Promise<RegionData[]> {
    try {
      const result = await this.ec2.describeRegions().promise();

      const regions: RegionData[] = result.Regions?.map(r => ({
        provider: 'aws',
        name: r.RegionName || '',
        region: r.RegionName || '',
        lat: 0, // TODO: Add region coordinates
        lng: 0,
        spotPrice: 0, // Will be queried separately
        onDemandPrice: 0,
        egressCostPerGb: this.getEgressCostByRegion(r.RegionName || ''),
      })) || [];

      return regions;
    } catch (error) {
      console.error('AWS regions error:', error);
      throw new Error(`Failed to list regions: ${error}`);
    }
  }

  async getInstanceCost(
    region: string,
    instanceType: string,
    spot?: boolean
  ): Promise<{ onDemandPrice: number; spotPrice?: number }> {
    try {
      // Query AWS Pricing API for on-demand price
      const pricingResult = await this.pricing.getProducts({
        ServiceCode: 'AmazonEC2',
        Filters: [
          {
            Field: 'location',
            Value: this.regionToLocation(region),
            Type: 'TERM_MATCH',
          },
          {
            Field: 'instanceType',
            Value: instanceType,
            Type: 'TERM_MATCH',
          },
          {
            Field: 'operatingSystem',
            Value: 'Windows',
            Type: 'TERM_MATCH',
          },
        ],
      }).promise();

      let onDemandPrice = 0;

      if (pricingResult.PriceList && pricingResult.PriceList.length > 0) {
        const pricing = JSON.parse(pricingResult.PriceList[0]);
        const terms = pricing.terms?.OnDemand || {};
        const term = Object.values(terms)[0] as any;
        const priceDimensions = term?.priceDimensions || {};
        const priceDim = Object.values(priceDimensions)[0] as any;
        onDemandPrice = parseFloat(priceDim?.pricePerUnit?.USD || '0');
      }

      // TODO: Query spot price from EC2
      const spotPrice = spot ? onDemandPrice * 0.3 : undefined;

      return { onDemandPrice, spotPrice };
    } catch (error) {
      console.error('AWS pricing error:', error);
      // Return fallback pricing
      return { onDemandPrice: 0.5 };
    }
  }

  async getEgressCostPerGb(region: string): Promise<number> {
    // AWS egress costs vary by region
    return this.getEgressCostByRegion(region);
  }

  async queryCosts(userId: string, startDate: Date, endDate: Date) {
    try {
      // Query AWS Cost Explorer for this account's costs
      const result = await this.costExplorer.getCostAndUsage({
        TimePeriod: {
          Start: startDate.toISOString().split('T')[0],
          End: endDate.toISOString().split('T')[0],
        },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        GroupBy: [
          { Type: 'DIMENSION', Key: 'SERVICE' },
        ],
      }).promise();

      let computeCost = 0;
      let egressCost = 0;

      // Parse results
      result.ResultsByTime?.forEach(timeResult => {
        timeResult.Groups?.forEach(group => {
          const service = group.Keys?.[0];
          const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || '0');

          if (service === 'Amazon Elastic Compute Cloud - Compute') {
            computeCost += cost;
          } else if (service?.includes('Data Transfer') || service?.includes('CloudFront')) {
            egressCost += cost;
          }
        });
      });

      return {
        computeCost,
        egressCost,
        storageCost: 0, // AWS includes this in compute for simplified reporting
      };
    } catch (error) {
      console.error('AWS cost query error:', error);
      return { computeCost: 0, egressCost: 0, storageCost: 0 };
    }
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.ec2.describeInstances({ MaxResults: 1 }).promise();
      return true;
    } catch (error) {
      console.error('AWS credential validation error:', error);
      return false;
    }
  }

  // Helper methods

  private regionToLocation(region: string): string {
    const locationMap: Record<string, string> = {
      'ap-southeast-1': 'Asia Pacific (Singapore)',
      'ap-northeast-1': 'Asia Pacific (Tokyo)',
      'ap-southeast-2': 'Asia Pacific (Sydney)',
      'us-east-1': 'US East (N. Virginia)',
      'us-west-2': 'US West (Oregon)',
      'eu-west-1': 'EU (Ireland)',
    };
    return locationMap[region] || region;
  }

  private getEgressCostByRegion(region: string): number {
    const egressRates: Record<string, number> = {
      'ap-southeast-1': 0.12,
      'ap-northeast-1': 0.12,
      'ap-southeast-2': 0.12,
      'us-east-1': 0.09,
      'us-west-2': 0.12,
      'eu-west-1': 0.09,
    };
    return egressRates[region] || 0.12;
  }
}
