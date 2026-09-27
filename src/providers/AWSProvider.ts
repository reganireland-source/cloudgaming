/**
 * ============================================================================
 * src/providers/AWSProvider.ts — TALKING TO AMAZON WEB SERVICES (AWS)
 * ============================================================================
 *
 * The one fully-built cloud provider. It fills in every operation required
 * by the CloudProvider contract (Provider.ts) using AWS's official
 * JavaScript library, the "AWS SDK".
 *
 * AWS VOCABULARY USED BELOW
 * -------------------------
 *   EC2            AWS's virtual-machine service ("Elastic Compute Cloud")
 *   instance       one virtual machine
 *   AMI            a disk template that new instances boot from
 *   EBS volume     a virtual hard disk attached to an instance
 *   snapshot       a point-in-time backup of an EBS volume
 *   region         a geographic location, e.g. ap-southeast-1 = Singapore
 *   availability zone (AZ)  one data centre inside a region, e.g. ap-southeast-1a
 *   spot instance  spare capacity sold cheaply; AWS can reclaim it at short notice
 *   Cost Explorer  AWS's billing/reporting API
 *
 * HOW AWS SDK v2 CALLS LOOK
 * -------------------------
 *   await this.ec2.stopInstances({ InstanceIds: [id] }).promise();
 * You call a method with a parameters object, then `.promise()` turns the
 * request into a Promise so you can `await` the result. (SDK v2 is now
 * end-of-life — AWS recommends v3 — but it still works.)
 *
 * ⚠️  KNOWN GAPS
 * -------------
 * - restoreFromSnapshot creates a disk from the snapshot but never attaches
 *   it (see the TODO), and launches with an empty image id, which AWS will
 *   reject. Restoring doesn't work end-to-end yet.
 * - replicateSnapshot creates its own EC2 client WITHOUT the user's access
 *   keys, so it relies on whatever AWS credentials the server itself has.
 * ============================================================================
 */

import AWS from 'aws-sdk';
import { CloudProvider, ProviderConfig, LaunchOptions, SnapshotInfo } from './Provider';
import { RegionData } from '../types';

export class AWSProvider extends CloudProvider {
  // `as const` makes the type the exact text 'aws' rather than any string,
  // which is what the CloudProvider contract requires.
  name = 'aws' as const;

  // `private` = only usable inside this class. These are the SDK "clients"
  // (objects that send requests to one AWS service each).
  private ec2: AWS.EC2;                  // virtual machines, disks, snapshots
  private pricing: AWS.Pricing;          // official price list
  private costExplorer: AWS.CostExplorer; // what you've actually been billed
  private region: string;

  /**
   * @param credentials this user's AWS details: { accessKeyId, secretAccessKey, region? }
   *   (loaded from the cloud_credentials table by the service layer)
   */
  constructor(credentials: any) {
    super(); // must call the parent class's constructor first
    // Initialize AWS services
    // Credentials are decrypted in the service layer and passed here
    // (Note: no decryption actually happens yet — they're stored as plain JSON.)
    this.region = credentials.region || 'ap-southeast-1';

    // Settings shared by the clients: which region, and whose account.
    const awsConfig = {
      region: this.region,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    };

    this.ec2 = new AWS.EC2(awsConfig);
    // The Pricing API only exists in a couple of US regions, whatever region
    // you're asking about — hence the hard-coded us-east-1.
    this.pricing = new AWS.Pricing({ region: 'us-east-1' }); // Pricing API only in US
    this.costExplorer = new AWS.CostExplorer(awsConfig);
  }

  /**
   * Create and start a new gaming VM.
   */
  async launchInstance(config: ProviderConfig, options: LaunchOptions) {
    try {
      // Describe the machine we want. The type annotation
      // `AWS.EC2.RunInstancesRequest` lets TypeScript check every field name.
      const params: AWS.EC2.RunInstancesRequest = {
        ImageId: options.imageId,              // which AMI to boot (our Packer-built gaming image)
        InstanceType: config.instanceType as any, // e.g. 'g4dn.xlarge' (4 CPUs + NVIDIA T4 GPU)
        MinCount: 1,                           // create exactly one machine
        MaxCount: 1,
        KeyName: options.keyName,              // SSH key pair allowed to log in
        SecurityGroupIds: [options.securityGroupId], // firewall rules
        // Spot pricing only if requested; otherwise leave the field out
        // (undefined) to get normal on-demand pricing.
        InstanceMarketOptions: options.spotInstance ? {
          MarketType: 'spot',
          SpotOptions: {
            MaxPrice: '0.50', // the most we'll pay per hour; Will be overridden with actual spot price
            SpotInstanceType: 'persistent', // keep the request alive if AWS reclaims the machine
          },
        } : undefined,
        // Tags are labels shown in the AWS console; they make it obvious
        // which machines this app created.
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

      // `?.[0]` = "the first item, if the list exists" — avoids a crash if
      // AWS returned no Instances list at all.
      const instance = result.Instances?.[0];

      if (!instance) {
        throw new Error('Failed to create instance');
      }

      // Look up the hourly price so we can show and track costs.
      const costPerHour = await this.getInstanceCost(config.region, config.instanceType, false);

      return {
        // `!` asserts "this is definitely set" — a new instance always has an id.
        instanceId: instance.InstanceId!,
        // A brand-new instance often has no public IP yet, hence the fallbacks.
        ipAddress: instance.PublicIpAddress || instance.PrivateIpAddress || '',
        costPerHour: costPerHour.onDemandPrice,
      };
    } catch (error) {
      console.error('AWS launch error:', error);
      // Re-throw with context so the caller's error message says what failed.
      throw new Error(`Failed to launch AWS instance: ${error}`);
    }
  }

  /** Power off (the disk is kept). */
  async stopInstance(instanceId: string): Promise<void> {
    try {
      await this.ec2.stopInstances({ InstanceIds: [instanceId] }).promise();
    } catch (error) {
      console.error('AWS stop error:', error);
      throw new Error(`Failed to stop instance: ${error}`);
    }
  }

  /** Power back on. */
  async startInstance(instanceId: string): Promise<void> {
    try {
      await this.ec2.startInstances({ InstanceIds: [instanceId] }).promise();
    } catch (error) {
      console.error('AWS start error:', error);
      throw new Error(`Failed to start instance: ${error}`);
    }
  }

  /** Destroy permanently. */
  async terminateInstance(instanceId: string): Promise<void> {
    try {
      await this.ec2.terminateInstances({ InstanceIds: [instanceId] }).promise();
    } catch (error) {
      console.error('AWS terminate error:', error);
      throw new Error(`Failed to terminate instance: ${error}`);
    }
  }

  /**
   * Current state + IP address. Never throws: on any problem it answers
   * 'unknown' so callers don't have to handle errors for a status check.
   */
  async getInstanceStatus(instanceId: string) {
    try {
      const result = await this.ec2.describeInstances({ InstanceIds: [instanceId] }).promise();
      // AWS groups instances into "reservations" (the request that launched
      // them), so the instance is nested one level deep.
      const instance = result.Reservations?.[0]?.Instances?.[0];

      if (!instance) {
        return { status: 'unknown' as const };
      }

      // AWS has more states (pending, stopping, shutting-down...). We map the
      // three we care about; anything else becomes 'unknown'.
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

  /**
   * Back up a machine's disk.
   * Steps: find the instance -> find its disk (EBS volume) -> read the disk's
   * size -> ask AWS to snapshot that disk.
   * Note: `diskPath` is accepted to match the contract but unused — AWS
   * snapshots a whole volume, not a folder.
   */
  async createSnapshot(instanceId: string, diskPath: string) {
    try {
      // Get the EBS volume attached to the instance
      const instanceDesc = await this.ec2.describeInstances({ InstanceIds: [instanceId] }).promise();
      const instance = instanceDesc.Reservations?.[0]?.Instances?.[0];

      if (!instance?.BlockDeviceMappings?.[0]) {
        throw new Error('No EBS volume found');
      }

      // BlockDeviceMappings = the disks attached to the machine. We take the
      // first one (the boot disk, where the games are installed).
      const volumeId = instance.BlockDeviceMappings[0].Ebs?.VolumeId;
      if (!volumeId) {
        throw new Error('Failed to get volume ID');
      }

      // Read the disk's size (for cost estimates).
      const volumeDesc = await this.ec2.describeVolumes({ VolumeIds: [volumeId] }).promise();
      const sizeGb = volumeDesc.Volumes?.[0]?.Size || 0;

      // Start the snapshot. AWS returns immediately with an id; the copy
      // itself completes in the background (can take minutes for large disks).
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

  /** Look up one snapshot's size and state. */
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

  /** Permanently delete a snapshot. */
  async deleteSnapshot(snapshotId: string): Promise<void> {
    try {
      await this.ec2.deleteSnapshot({ SnapshotId: snapshotId }).promise();
    } catch (error) {
      console.error('AWS delete snapshot error:', error);
      throw new Error(`Failed to delete snapshot: ${error}`);
    }
  }

  /**
   * Bring a machine back from a snapshot.
   * ⚠️ INCOMPLETE — see KNOWN GAPS at the top of this file.
   * The intended sequence: make a disk from the snapshot -> wait for it ->
   * launch a machine -> attach the disk. The last step isn't written yet.
   */
  async restoreFromSnapshot(snapshotId: string, config: ProviderConfig) {
    try {
      // Confirms the snapshot exists (throws if not). The result isn't used further.
      const snapshot = await this.getSnapshot(snapshotId);

      // Create a new disk whose contents are the snapshot.
      const volume = await this.ec2.createVolume({
        SnapshotId: snapshotId,
        AvailabilityZone: `${this.region}a`, // Assume first AZ (a disk lives in ONE data centre)
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

      // `waitFor` polls AWS until the disk reaches the 'available' state.
      await this.ec2.waitFor('volumeAvailable', { VolumeIds: [volume.VolumeId!] }).promise();

      // Launch instance
      const launchResult = await this.launchInstance(config, {
        imageId: '', // Will be ignored; we'll attach the volume instead (actually: AWS rejects an empty image id)
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

  /**
   * Copy a snapshot to another AWS region (e.g. Singapore -> Tokyo) so a
   * machine can later be restored closer to the player.
   * Only AWS -> AWS is supported; converting another cloud's disk format
   * into an AWS snapshot is not built.
   */
  async replicateSnapshot(
    sourceSnapshotId: string,
    sourceProvider: string,
    sourceRegion: string,
    targetRegion: string
  ): Promise<{ snapshotId: string }> {
    if (sourceProvider !== 'aws') {
      throw new Error(
        `Cross-cloud snapshot import from ${sourceProvider} is not implemented yet`
      );
    }

    try {
      // CopySnapshot is called against the destination region's endpoint
      // (the copy is "pulled" into the target region). ⚠️ This client is
      // created without the user's access keys — see KNOWN GAPS.
      const destEc2 = new AWS.EC2({ region: targetRegion });
      const result = await destEc2.copySnapshot({
        SourceRegion: sourceRegion,
        SourceSnapshotId: sourceSnapshotId,
        DestinationRegion: targetRegion,
        Description: `Replicated from ${sourceRegion}`,
      }).promise();

      if (!result.SnapshotId) {
        throw new Error('Copy snapshot did not return a snapshot ID');
      }

      return { snapshotId: result.SnapshotId };
    } catch (error) {
      console.error('AWS replicate snapshot error:', error);
      throw new Error(`Failed to replicate snapshot: ${error}`);
    }
  }

  /**
   * List all AWS regions. Location and prices are placeholders (zeros) —
   * AWS's region list doesn't include them.
   */
  async getRegions(): Promise<RegionData[]> {
    try {
      const result = await this.ec2.describeRegions().promise();

      // `.map` converts each AWS region record into our RegionData shape.
      // `|| []` handles AWS returning no list at all.
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

  /**
   * Hourly price for a machine type, from AWS's official Pricing API.
   * Filters for Windows pricing, since the gaming machines run Windows
   * (Windows machines cost more than Linux ones — the licence is included).
   * If the lookup fails, returns $0.50/hour as a safe estimate instead of
   * failing the whole launch.
   */
  async getInstanceCost(
    region: string,
    instanceType: string,
    spot?: boolean
  ): Promise<{ onDemandPrice: number; spotPrice?: number }> {
    try {
      // The Pricing API wants a location NAME ("Asia Pacific (Singapore)"),
      // not a region code, hence regionToLocation().
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

      // AWS returns each price as a deeply nested JSON TEXT blob. We parse it
      // and dig down: terms -> OnDemand -> (first term) -> priceDimensions ->
      // (first dimension) -> pricePerUnit -> USD. Object.values(...)[0] grabs
      // the first entry of an object whose keys are unpredictable ids.
      if (pricingResult.PriceList && pricingResult.PriceList.length > 0) {
        const pricing = JSON.parse(pricingResult.PriceList[0]);
        const terms = pricing.terms?.OnDemand || {};
        const term = Object.values(terms)[0] as any;
        const priceDimensions = term?.priceDimensions || {};
        const priceDim = Object.values(priceDimensions)[0] as any;
        onDemandPrice = parseFloat(priceDim?.pricePerUnit?.USD || '0');
      }

      // TODO: Query spot price from EC2
      // For now, estimate spot at 30% of the on-demand price.
      const spotPrice = spot ? onDemandPrice * 0.3 : undefined;

      return { onDemandPrice, spotPrice };
    } catch (error) {
      console.error('AWS pricing error:', error);
      // Return fallback pricing
      return { onDemandPrice: 0.5 };
    }
  }

  /** Price per GB of data sent out to the internet in this region. */
  async getEgressCostPerGb(region: string): Promise<number> {
    // AWS egress costs vary by region
    return this.getEgressCostByRegion(region);
  }

  /**
   * What was actually spent, from AWS Cost Explorer. Groups charges by AWS
   * service and sorts them into compute vs data-transfer. Returns zeros on
   * failure rather than throwing.
   * Note: this reports costs for the whole AWS ACCOUNT; `userId` is unused.
   */
  async queryCosts(userId: string, startDate: Date, endDate: Date) {
    try {
      const result = await this.costExplorer.getCostAndUsage({
        TimePeriod: {
          // Cost Explorer wants plain dates ("2026-09-27"). toISOString()
          // gives "2026-09-27T06:07:34.777Z"; split('T')[0] keeps the date part.
          Start: startDate.toISOString().split('T')[0],
          End: endDate.toISOString().split('T')[0],
        },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],             // the actual cost, before discounts are shared out
        GroupBy: [
          { Type: 'DIMENSION', Key: 'SERVICE' }, // one line per AWS service
        ],
      }).promise();

      let computeCost = 0;
      let egressCost = 0;

      // Walk every day, and every service line within each day, adding the
      // cost to the right bucket.
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

  /**
   * Do these credentials work? Makes the cheapest possible read-only call
   * (list at most 1 instance). Success = valid; any error = invalid.
   */
  async validateCredentials(): Promise<boolean> {
    try {
      await this.ec2.describeInstances({ MaxResults: 1 }).promise();
      return true;
    } catch (error) {
      console.error('AWS credential validation error:', error);
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Helper methods — `private`, only used inside this class.
  // ---------------------------------------------------------------------

  /** Region code -> the location name the Pricing API expects. */
  private regionToLocation(region: string): string {
    const locationMap: Record<string, string> = {
      'ap-southeast-1': 'Asia Pacific (Singapore)',
      'ap-northeast-1': 'Asia Pacific (Tokyo)',
      'ap-southeast-2': 'Asia Pacific (Sydney)',
      'us-east-1': 'US East (N. Virginia)',
      'us-west-2': 'US West (Oregon)',
      'eu-west-1': 'EU (Ireland)',
    };
    // Unknown region: pass the code through unchanged (the lookup will
    // probably find nothing, and the $0.50 fallback kicks in).
    return locationMap[region] || region;
  }

  /** Approximate egress price ($ per GB) by region; $0.12 if not listed. */
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
