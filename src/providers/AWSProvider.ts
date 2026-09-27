/**
 * ============================================================================
 * src/providers/AWSProvider.ts — AMAZON WEB SERVICES (AWS)
 * ============================================================================
 *
 * The AWS version of the CloudProvider contract (Provider.ts). It creates,
 * starts, stops, deletes and snapshots GPU virtual machines in the USER'S
 * OWN AWS account, using the access key they added on the Config page
 * (stored encrypted — see CredentialService.ts). It mirrors GCPProvider.ts:
 * same steps, same chatty progress messages, AWS words.
 *
 * AWS VOCABULARY USED BELOW
 * -------------------------
 *   EC2              AWS's virtual-machine service ("Elastic Compute Cloud")
 *   instance         one virtual machine; its type (g4dn.xlarge...) fixes CPU, RAM and GPU
 *   AMI              "Amazon Machine Image" — the disk template a machine boots from
 *   EBS volume       a virtual hard disk; the "root volume" is the one it boots from
 *   snapshot         a point-in-time backup of an EBS volume
 *   region / AZ      a city (ap-southeast-1 = Singapore) / one data centre in it (ap-southeast-1a)
 *   VPC / subnet     the private network machines live on; every account has a
 *                    ready-made "default VPC" per region with one subnet per AZ
 *   security group   a firewall attached to a machine
 *   user data        a script EC2 hands to the machine to run on first boot
 *   spot instance    spare capacity sold cheaply; AWS can take it back at short notice
 *
 * KEY IDEAS
 * ---------
 * - REGIONS: everything in EC2 belongs to one region, so we keep one API
 *   client per region (see ec2For()).
 * - OUR INSTANCE ID is "region/instance-id", e.g. "ap-southeast-1/i-0abc123…",
 *   because every later call (stop, start...) needs to know the region too.
 *   Snapshot ids work the same way: "ap-southeast-1/snap-0abc…". Bare
 *   "i-…"/"snap-…" ids (from older records) are assumed to be in the
 *   default region.
 * - AVAILABILITY ZONES: GPUs sell out per zone, so launching tries each zone
 *   of the region in turn (via the default VPC's subnet in that zone) until
 *   one works.
 * - WAITING: AWS calls return straight away and the work finishes later.
 *   The SDK's `waitFor('instanceRunning', ...)` polls until the machine
 *   reaches that state (or gives up and throws).
 * - NO SSH: the machine configures itself with the shared setup script
 *   (shared/setupScript.ts), passed as EC2 "user data". We watch its
 *   progress through the machine's serial console (GetConsoleOutput).
 * - CHATTY: every step calls this.report(...), which (when a reporter is
 *   attached) writes a line into the operation log the frontend shows live.
 *
 * HOW AWS SDK v2 CALLS LOOK
 * -------------------------
 *   await ec2.stopInstances({ InstanceIds: [id] }).promise();
 * You call a method with a parameters object, then `.promise()` turns the
 * request into a Promise you can `await`. (SDK v2 is in maintenance mode —
 * AWS recommends v3 — but it's what's installed and it works fine.)
 *
 * CREDENTIALS SHAPE
 * -----------------
 *   { accessKeyId: 'AKIA…', secretAccessKey: '…', region?: 'ap-southeast-1' }
 * The region is optional: each call gets its region from the machine's id
 * or from the launch form. The secret is never logged or returned.
 * ============================================================================
 */

import crypto from 'crypto';
import zlib from 'zlib';
import AWS from 'aws-sdk';
import { CloudProvider, ProviderConfig, LaunchOptions, SnapshotInfo } from './Provider';
import { RegionData } from '../types';
import { AWS_CONSOLE, FriendlyCloudError, isAwsCapacityError, toFriendlyError } from './aws/errors';
import {
  AWS_REGIONS,
  AWS_SHAPES,
  AWS_CATALOG,
  DEFAULT_REGION,
  SNAPSHOT_PER_GB_MONTH,
  UBUNTU_NAME_PATTERNS,
  UBUNTU_OWNER,
  estimateHourly,
  findRegion,
  findShape,
} from './aws/catalog';
import { RESOURCE_TAG, STREAMING_FIREWALL_NAME, SUNSHINE_PORT_RANGES } from './shared/streaming';
import { buildSetupScript, parseSetupStages, SetupStage } from './shared/setupScript';
import type { InventoryItem } from './shared/types';

/** The parsed, checked credentials. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

/** Our status words (see Provider.ts). */
type Status = 'starting' | 'running' | 'stopping' | 'stopped' | 'terminated' | 'unknown';

/** Is this a "does not exist" error from AWS? */
function isNotFound(error: any): boolean {
  return /\.NotFound$|NotFound|does not exist/i.test(String(error?.code)) ||
    /does not exist|not found/i.test(String(error?.message));
}

/**
 * Is this an error that means "this REGION can't be used by this account"
 * rather than "something is broken"? Regions launched after 2019 (and any
 * region an administrator disabled) must be switched on ("opted in") per
 * account; calls to one that isn't answer AuthFailure / OptInRequired /
 * UnauthorizedOperation. listResources() skips such regions quietly.
 */
function isRegionUnavailable(error: any): boolean {
  return /AuthFailure|OptInRequired|UnauthorizedOperation|InvalidClientTokenId|not subscribed|not enabled|PendingVerification/i
    .test(`${error?.code} ${error?.message}`);
}

/** Read one tag's value from an AWS tag list (undefined if it isn't there). */
function tagValue(list: AWS.EC2.TagList | undefined, key: string): string | undefined {
  return list?.find((t) => t.Key === key)?.Value;
}

/** A Date (or nothing) as ISO text for the inventory's createdAt. */
function iso(date: Date | undefined): string | undefined {
  return date ? new Date(date).toISOString() : undefined;
}

/** Round money to cents (monthly) — hourly values come pre-rounded from the catalog. */
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Elastic IP price: since February 2024 AWS bills EVERY public IPv4 address
 * $0.005/hour (≈ $3.65/month), attached or not. An Elastic IP that isn't
 * attached to a machine is pure waste.
 */
const PUBLIC_IPV4_PER_HOUR = 0.005;

/** AWS "tags" for everything we create: a Name plus our app label. */
function tags(name: string, extra: Record<string, string> = {}): AWS.EC2.TagList {
  return [
    { Key: 'Name', Value: name },
    { Key: RESOURCE_TAG.key, Value: RESOURCE_TAG.value },
    ...Object.entries(extra).map(([Key, Value]) => ({ Key, Value })),
  ];
}

export class AWSProvider extends CloudProvider {
  // `as const` makes the type the exact text 'aws' rather than any string.
  name = 'aws' as const;
  // We install Sunshine ourselves via user data — MachineService must not SSH in.
  readonly selfConfiguring = true;

  /** Region used when an id doesn't say (old records) and for account-wide calls. */
  readonly defaultRegion: string;

  private readonly creds: AwsCredentials;
  // One EC2 client per region, created on first use (see ec2For()).
  private readonly ec2Clients = new Map<string, AWS.EC2>();

  /**
   * Turn whatever was stored into checked credentials, or throw a friendly
   * error explaining exactly what's missing.
   */
  static parseCredentials(raw: any): AwsCredentials {
    // .trim() removes spaces/newlines that sneak in when copying from a browser.
    const accessKeyId = String(raw?.accessKeyId ?? '').trim();
    const secretAccessKey = String(raw?.secretAccessKey ?? '').trim();
    if (!accessKeyId || !secretAccessKey) {
      throw new FriendlyCloudError({
        code: 'AWS_KEY_MISSING',
        title: 'AWS access key ID or secret is missing',
        explanation: 'Both halves of an AWS access key are needed: the access key ID (starts with "AKIA") and its secret access key.',
        fixes: [
          'In the AWS console open IAM → Users → your user → "Security credentials" → "Create access key".',
          'Choose "Application running outside AWS", then copy BOTH values (the secret is shown only once).',
          'On the Config page here, add the AWS credentials again with both values.',
        ],
        consoleUrl: AWS_CONSOLE.iamUsers,
        consoleLabel: 'Open IAM users',
      });
    }
    const region = raw?.region ? String(raw.region).trim() : undefined;
    return { accessKeyId, secretAccessKey, region };
  }

  /**
   * @param credentials this user's AWS details: { accessKeyId, secretAccessKey, region? }
   *   (loaded and decrypted by the service layer)
   */
  constructor(credentials: any) {
    super(); // must call the parent class's constructor first
    this.creds = AWSProvider.parseCredentials(credentials);
    this.defaultRegion = this.creds.region || DEFAULT_REGION;
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /** Settings shared by every AWS client: whose account, which region. */
  private clientConfig(region: string): AWS.EC2.ClientConfiguration {
    return {
      region,
      accessKeyId: this.creds.accessKeyId,
      secretAccessKey: this.creds.secretAccessKey,
      maxRetries: 3, // the SDK retries throttling/network blips itself
    };
  }

  /** The EC2 client for one region (created once, then reused). */
  private ec2For(region: string): AWS.EC2 {
    let client = this.ec2Clients.get(region);
    if (!client) {
      client = new AWS.EC2(this.clientConfig(region));
      this.ec2Clients.set(region, client);
    }
    return client;
  }

  /** "ap-southeast-1/i-0abc" -> { region: 'ap-southeast-1', id: 'i-0abc' } */
  private splitId(fullId: string): { region: string; id: string } {
    const slash = fullId.indexOf('/');
    if (slash === -1) return { region: this.defaultRegion, id: fullId }; // older bare ids
    const region = fullId.slice(0, slash);
    const id = fullId.slice(slash + 1);
    if (!region || !id) throw new Error(`Not an AWS id (expected "region/id"): ${fullId}`);
    return { region, id };
  }

  /** Look up one instance, or undefined if AWS says it doesn't exist. */
  private async describeInstance(region: string, instanceId: string): Promise<AWS.EC2.Instance | undefined> {
    try {
      const result = await this.ec2For(region).describeInstances({ InstanceIds: [instanceId] }).promise();
      // AWS groups instances into "reservations" (the request that launched
      // them), so the instance is nested one level deep.
      return result.Reservations?.[0]?.Instances?.[0];
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /**
   * Find the region's DEFAULT VPC and its default subnets (one per
   * availability zone). Throws a friendly "how to create one" error if the
   * user deleted it.
   */
  private async getDefaultVpc(region: string): Promise<{ vpcId: string; subnets: Array<{ subnetId: string; zone: string }> }> {
    const ec2 = this.ec2For(region);
    const vpcs = await ec2.describeVpcs({ Filters: [{ Name: 'is-default', Values: ['true'] }] }).promise();
    const vpcId = vpcs.Vpcs?.[0]?.VpcId;
    if (!vpcId) {
      throw new FriendlyCloudError({
        code: 'AWS_NO_DEFAULT_VPC',
        title: `No default VPC (network) in ${region}`,
        explanation:
          'Machines are created in the region\'s "default VPC" — the ready-made network every AWS account gets. It has been deleted in this region.',
        fixes: [
          `In the AWS console, switch the region (top right) to ${region}, open VPC → "Your VPCs" → Actions → "Create default VPC".`,
          `Or with the AWS CLI: aws ec2 create-default-vpc --region ${region}`,
          'Then try again.',
        ],
        consoleUrl: `https://${region}.console.aws.amazon.com/vpcconsole/home?region=${region}#vpcs:`,
        consoleLabel: 'Open VPCs',
      });
    }
    const subnets = await ec2.describeSubnets({
      Filters: [
        { Name: 'vpc-id', Values: [vpcId] },
        { Name: 'default-for-az', Values: ['true'] },
      ],
    }).promise();
    const list = (subnets.Subnets || [])
      .filter((s) => s.SubnetId && s.AvailabilityZone)
      .map((s) => ({ subnetId: s.SubnetId!, zone: s.AvailabilityZone! }))
      .sort((a, b) => a.zone.localeCompare(b.zone)); // try zones a, b, c… in order
    if (!list.length) {
      throw new FriendlyCloudError({
        code: 'AWS_NO_DEFAULT_SUBNET',
        title: `The default VPC in ${region} has no subnets`,
        explanation: 'The default network exists but its per-zone subnets were deleted, so there is nowhere to put a machine.',
        fixes: [`With the AWS CLI, recreate one per zone: aws ec2 create-default-subnet --availability-zone ${region}a --region ${region} (repeat for b, c).`],
        consoleUrl: `https://${region}.console.aws.amazon.com/vpcconsole/home?region=${region}#subnets:`,
        consoleLabel: 'Open subnets',
      });
    }
    return { vpcId, subnets: list };
  }

  /**
   * Make sure the security group (firewall) that opens the streaming ports
   * exists in this VPC, and return its id. Created once per region.
   */
  private async ensureSecurityGroup(region: string, vpcId: string): Promise<string> {
    const ec2 = this.ec2For(region);
    const existing = await ec2.describeSecurityGroups({
      Filters: [
        { Name: 'group-name', Values: [STREAMING_FIREWALL_NAME] },
        { Name: 'vpc-id', Values: [vpcId] },
      ],
    }).promise();
    const found = existing.SecurityGroups?.[0]?.GroupId;
    if (found) {
      await this.report('info', `Security group "${STREAMING_FIREWALL_NAME}" already exists (${found}) — streaming ports are open.`);
      return found;
    }

    const portText = SUNSHINE_PORT_RANGES
      .map((p) => `${p.protocol.toUpperCase()} ${p.from === p.to ? p.from : `${p.from}-${p.to}`}`)
      .join(', ');
    await this.report('info', `Creating security group "${STREAMING_FIREWALL_NAME}" to open the streaming ports (one-time per region)…`, portText);
    const created = await ec2.createSecurityGroup({
      GroupName: STREAMING_FIREWALL_NAME,
      Description: 'Gints Global Gaming Hubjob: Sunshine/Moonlight streaming ports',
      VpcId: vpcId,
      TagSpecifications: [{ ResourceType: 'security-group', Tags: tags(STREAMING_FIREWALL_NAME) }],
    }).promise();
    const groupId = created.GroupId!;

    // One "ingress" (incoming) rule per port range, open to the whole
    // internet (0.0.0.0/0) — you play from wherever you are. Sunshine's admin
    // page (47990) is password-protected. Outgoing traffic is allowed by default.
    await ec2.authorizeSecurityGroupIngress({
      GroupId: groupId,
      IpPermissions: SUNSHINE_PORT_RANGES.map((p) => ({
        IpProtocol: p.protocol,
        FromPort: p.from,
        ToPort: p.to,
        IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'Sunshine / Moonlight' }],
      })),
    }).promise();
    await this.report('success', `Security group created (${groupId}).`);
    return groupId;
  }

  /**
   * The newest official Ubuntu 22.04 image in this region. AMI ids are
   * different in every region and change with each Ubuntu update, so we
   * search by Canonical's account id + the image name pattern.
   */
  async findUbuntuAmi(region: string): Promise<{ imageId: string; name: string; rootDeviceName: string }> {
    const result = await this.ec2For(region).describeImages({
      Owners: [UBUNTU_OWNER],
      Filters: [
        { Name: 'name', Values: UBUNTU_NAME_PATTERNS },
        { Name: 'architecture', Values: ['x86_64'] },
        { Name: 'state', Values: ['available'] },
      ],
    }).promise();
    // CreationDate is ISO text ("2026-08-14T10:22:31.000Z"), so sorting the
    // text newest-first also sorts by date.
    const images = (result.Images || []).sort((a, b) => String(b.CreationDate).localeCompare(String(a.CreationDate)));
    const newest = images[0];
    if (!newest?.ImageId) {
      throw new FriendlyCloudError({
        code: 'AWS_NO_UBUNTU_IMAGE',
        title: `Couldn't find the Ubuntu 22.04 image in ${region}`,
        explanation: 'Canonical publishes Ubuntu images in every standard AWS region, so this usually means the region isn\'t enabled for your account.',
        fixes: ['Pick a different region, or enable this one under your AWS account settings → AWS Regions.'],
        consoleUrl: AWS_CONSOLE.accountRegions,
        consoleLabel: 'Open account settings',
      });
    }
    return { imageId: newest.ImageId, name: newest.Name || newest.ImageId, rootDeviceName: newest.RootDeviceName || '/dev/sda1' };
  }

  /**
   * Which availability zones of the region actually offer this instance
   * type? Saves trying zones that can never work. Returns undefined if the
   * lookup itself fails (then we just try every zone).
   */
  private async zonesOffering(region: string, instanceType: string): Promise<Set<string> | undefined> {
    try {
      const result = await this.ec2For(region).describeInstanceTypeOfferings({
        LocationType: 'availability-zone',
        Filters: [{ Name: 'instance-type', Values: [instanceType] }],
      }).promise();
      return new Set((result.InstanceTypeOfferings || []).map((o) => String(o.Location)));
    } catch {
      return undefined;
    }
  }

  /** Check the shape and region are ones we support; throw friendly errors if not. */
  private checkShapeAndRegion(config: ProviderConfig) {
    const shape = findShape(config.instanceType);
    if (!shape) {
      throw new FriendlyCloudError({
        code: 'UNKNOWN_SHAPE',
        title: `Unknown machine type "${config.instanceType}"`,
        explanation: 'This machine type isn\'t one Gints Global Gaming Hubjob knows how to launch on AWS.',
        fixes: [`Choose one of: ${AWS_SHAPES.map((s) => `${s.id} (${s.label})`).join(', ')}.`],
      });
    }
    const region = findRegion(config.region);
    if (!region) {
      throw new FriendlyCloudError({
        code: 'UNKNOWN_REGION',
        title: `Unsupported region "${config.region}"`,
        explanation: 'We only launch in AWS regions that offer NVIDIA T4 (g4dn) or A10G (g5) machines.',
        fixes: [`Choose one of: ${AWS_REGIONS.map((r) => `${r.name} (${r.id})`).join(', ')}.`],
      });
    }
    if (!region.gpus.includes(shape.gpuModel)) {
      throw new FriendlyCloudError({
        code: 'GPU_NOT_IN_REGION',
        title: `${shape.gpuModel} GPUs aren't offered in ${region.name}`,
        explanation: `AWS doesn't sell ${shape.id} machines in ${region.id}.`,
        fixes: [`Pick a ${region.gpus.join(' or ')} machine, or another region.`],
      });
    }
    return { shape, region };
  }

  /**
   * Create one machine, trying each availability zone of the region until
   * one works. Shared by launchInstance (fresh Ubuntu disk) and
   * restoreFromSnapshot (boots from a temporary image made from a snapshot).
   */
  private async createMachine(
    config: ProviderConfig,
    options: {
      spot: boolean;
      diskSizeGb: number;
      sunshineUsername: string;
      sunshinePassword: string;
      autoStopMinutes?: number;
      /** Boot from this image instead of the newest Ubuntu (used by restore). */
      image?: { imageId: string; rootDeviceName: string; label: string };
    }
  ): Promise<{ instanceId: string; ipAddress: string; costPerHour: number }> {
    const { shape, region } = this.checkShapeAndRegion(config);
    const ec2 = this.ec2For(region.id);

    await this.report('info', `${shape.id} (${shape.label}) · ${region.name} (${region.id}) · ${options.diskSizeGb} GB disk` +
      `${options.spot ? ' · SPOT (cheaper, can be interrupted)' : ''}`);

    // 1. Network + firewall.
    await this.report('info', `Looking up the default network (VPC) in ${region.id}…`);
    const vpc = await this.getDefaultVpc(region.id);
    const groupId = await this.ensureSecurityGroup(region.id, vpc.vpcId);

    // 2. Which disk image to boot.
    let image = options.image;
    if (!image) {
      await this.report('info', 'Finding the newest official Ubuntu 22.04 image…');
      const ubuntu = await this.findUbuntuAmi(region.id);
      image = { imageId: ubuntu.imageId, rootDeviceName: ubuntu.rootDeviceName, label: ubuntu.name };
      await this.report('info', `Using ${ubuntu.imageId} (${ubuntu.name}).`);
    }

    // 3. Which zones to try: only those that offer this machine type.
    const offering = await this.zonesOffering(region.id, shape.id);
    let subnets = vpc.subnets;
    if (offering) {
      subnets = vpc.subnets.filter((s) => offering.has(s.zone));
      if (!subnets.length) {
        throw new FriendlyCloudError({
          code: 'AWS_TYPE_NOT_IN_REGION',
          title: `${shape.id} isn't offered in any zone of ${region.name} for your account`,
          explanation: 'AWS lists no availability zone in this region that sells this machine type.',
          fixes: ['Pick a different machine type (g4dn is the most widely available), or another region.'],
        });
      }
      await this.report('info', `${shape.id} is offered in: ${subnets.map((s) => s.zone).join(', ')}.`);
    }

    // 4. The setup script, handed over as "user data". EC2 wants it base64-encoded.
    // EC2 limits user data to 16 KB (before base64) and our script is ~14 KB,
    // so it's gzip-compressed (~5 KB). cloud-init on Ubuntu detects gzip and
    // unpacks it automatically.
    const userData = zlib.gzipSync(buildSetupScript({
      sunshineUsername: options.sunshineUsername,
      sunshinePassword: options.sunshinePassword,
      autoStopMinutes: options.autoStopMinutes,
    })).toString('base64');

    // A short unique name, shown in the AWS console's Name column.
    const name = `cg-${crypto.randomBytes(4).toString('hex')}`;
    const zoneErrors: string[] = [];

    for (const subnet of subnets) {
      await this.report('info', `Trying zone ${subnet.zone}…`);

      const params: AWS.EC2.RunInstancesRequest = {
        ImageId: image.imageId,
        InstanceType: shape.id,
        MinCount: 1, // exactly one machine
        MaxCount: 1,
        UserData: userData,
        // The network card: in this zone's subnet, behind our security
        // group, WITH a public IP (needed to stream to you).
        NetworkInterfaces: [{
          DeviceIndex: 0,
          SubnetId: subnet.subnetId,
          Groups: [groupId],
          AssociatePublicIpAddress: true,
          DeleteOnTermination: true,
        }],
        // The boot disk: gp3 SSD of the requested size, deleted with the
        // machine, encrypted with your account's default AWS key.
        BlockDeviceMappings: [{
          DeviceName: image.rootDeviceName,
          Ebs: {
            VolumeSize: options.diskSizeGb,
            VolumeType: 'gp3',
            DeleteOnTermination: true,
            ...(options.image ? {} : { Encrypted: true }), // a snapshot image keeps its own encryption setting
          },
        }],
        // "shutdown" from inside the machine just stops it (keeps the disk).
        InstanceInitiatedShutdownBehavior: 'stop',
        // Require the safer "IMDSv2" for the machine's metadata service.
        MetadataOptions: { HttpTokens: 'required', HttpEndpoint: 'enabled' },
        TagSpecifications: [
          { ResourceType: 'instance', Tags: tags(name) },
          { ResourceType: 'volume', Tags: tags(name) },
        ],
        // Spot: 'persistent' + 'stop' means that if AWS takes the capacity
        // back, the machine is STOPPED (disk kept) rather than deleted, and
        // can be started again later — the same settings CloudyPad uses.
        ...(options.spot
          ? {
              InstanceMarketOptions: {
                MarketType: 'spot',
                SpotOptions: { SpotInstanceType: 'persistent', InstanceInterruptionBehavior: 'stop' },
              },
            }
          : {}),
      };

      let instanceId: string | undefined;
      try {
        const result = await ec2.runInstances(params).promise();
        instanceId = result.Instances?.[0]?.InstanceId;
        if (!instanceId) throw new Error('AWS accepted the request but returned no instance id');
        await this.report('info', `AWS accepted the request — ${instanceId} is booting in ${subnet.zone} (usually 20–90 s)…`);
      } catch (error: any) {
        if (isAwsCapacityError(error)) {
          const friendly = toFriendlyError(error, 'aws');
          zoneErrors.push(`${subnet.zone}: ${error.code || ''} ${error.message}`);
          await this.report('warn', `${subnet.zone}: ${friendly.code === 'AWS_NO_CAPACITY' ? 'no spare GPUs right now' : friendly.title} — trying the next zone.`, error.message);
          continue;
        }
        // Quota, permission, credentials... would fail in every zone: stop now.
        throw error;
      }

      // Wait for "running". Checks every 5 s for up to 5 minutes.
      try {
        await ec2.waitFor('instanceRunning', { InstanceIds: [instanceId], $waiter: { delay: 5, maxAttempts: 60 } }).promise();
      } catch (waitError: any) {
        // The machine didn't reach "running". Spot/capacity problems can show
        // up here (the instance is created, then immediately terminated) — in
        // that case try the next zone; anything else is a real failure.
        const instance = await this.describeInstance(region.id, instanceId).catch(() => undefined);
        const reason = instance?.StateReason?.Message || waitError?.message || 'unknown reason';
        if (isAwsCapacityError(reason)) {
          zoneErrors.push(`${subnet.zone}: ${reason}`);
          await this.report('warn', `${subnet.zone}: AWS couldn't place the machine (${reason}) — trying the next zone.`);
          await ec2.terminateInstances({ InstanceIds: [instanceId] }).promise().catch(() => undefined);
          continue;
        }
        throw new Error(`Machine ${instanceId} did not start: ${reason}`);
      }

      const instance = await this.describeInstance(region.id, instanceId);
      const ipAddress = instance?.PublicIpAddress || '';
      await this.report('success', `Machine ${name} (${instanceId}) is running in ${subnet.zone}${ipAddress ? ` with public IP ${ipAddress}` : ''}.`);
      await this.report('info', 'It now installs the NVIDIA driver, desktop, Sunshine and Steam by itself (about 10–15 minutes, with one reboot).');
      return {
        instanceId: `${region.id}/${instanceId}`,
        ipAddress,
        costPerHour: estimateHourly(shape.id, region.id, options.spot),
      };
    }

    // Every zone failed with a zone-specific problem.
    throw new Error(`InsufficientInstanceCapacity in all zones of ${region.id}: ${zoneErrors.join(' | ')}`);
  }

  // ==========================================================================
  // The CloudProvider contract
  // ==========================================================================

  async launchInstance(
    config: ProviderConfig,
    options: LaunchOptions
  ): Promise<{ instanceId: string; ipAddress: string; costPerHour: number }> {
    // options.imageId / keyName / securityGroupId are legacy fields: we pick
    // the image and firewall ourselves, and there's no SSH key (no SSH).
    return this.createMachine(config, {
      spot: !!options.spotInstance,
      diskSizeGb: options.diskSizeGb || 150,
      sunshineUsername: options.sunshineUsername || 'gamer',
      sunshinePassword: options.sunshinePassword || crypto.randomBytes(12).toString('base64url'),
      autoStopMinutes: options.autoStopMinutes,
    });
  }

  async stopInstance(instanceId: string): Promise<void> {
    const { region, id } = this.splitId(instanceId);
    const ec2 = this.ec2For(region);
    await this.report('info', `Asking AWS to stop ${id} (compute billing stops; the disk is kept)…`);
    await ec2.stopInstances({ InstanceIds: [id] }).promise();
    await this.report('info', 'Waiting for it to finish shutting down (usually under a minute)…');
    await ec2.waitFor('instanceStopped', { InstanceIds: [id] }).promise();
    await this.report('success', `${id} is stopped.`);
  }

  async startInstance(instanceId: string): Promise<void> {
    const { region, id } = this.splitId(instanceId);
    const ec2 = this.ec2For(region);
    await this.report('info', `Asking AWS to start ${id}…`);
    await ec2.startInstances({ InstanceIds: [id] }).promise();
    await ec2.waitFor('instanceRunning', { InstanceIds: [id] }).promise();
    await this.report('success', `${id} is running. (Its public IP has probably changed — we'll read the new one.)`);
  }

  async terminateInstance(instanceId: string): Promise<void> {
    const { region, id } = this.splitId(instanceId);
    const ec2 = this.ec2For(region);

    const instance = await this.describeInstance(region, id);
    if (!instance || instance.State?.Name === 'terminated') {
      await this.report('warn', `${id} was already gone at AWS (deleted elsewhere?). Cleaning up our record.`);
      return;
    }

    // A PERSISTENT spot request would launch a replacement machine after we
    // delete this one, so cancel the request first.
    if (instance.SpotInstanceRequestId) {
      await this.report('info', `Cancelling spot request ${instance.SpotInstanceRequestId} so AWS doesn't relaunch the machine…`);
      try {
        await ec2.cancelSpotInstanceRequests({ SpotInstanceRequestIds: [instance.SpotInstanceRequestId] }).promise();
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    await this.report('info', `Asking AWS to terminate ${id} and delete its disk…`);
    try {
      await ec2.terminateInstances({ InstanceIds: [id] }).promise();
      await ec2.waitFor('instanceTerminated', { InstanceIds: [id] }).promise();
      await this.report('success', `${id} terminated — it no longer costs anything.`);
    } catch (error) {
      if (isNotFound(error)) {
        await this.report('warn', `${id} was already gone at AWS. Cleaning up our record.`);
        return;
      }
      throw error;
    }
  }

  async getInstanceStatus(instanceId: string): Promise<{ status: Status; ipAddress?: string }> {
    const { region, id } = this.splitId(instanceId);
    const instance = await this.describeInstance(region, id);
    if (!instance) return { status: 'terminated' };
    // AWS's states -> ours.
    const map: Record<string, Status> = {
      pending: 'starting',
      running: 'running',
      stopping: 'stopping',
      'shutting-down': 'stopping', // on its way to terminated
      stopped: 'stopped',
      terminated: 'terminated',
    };
    return {
      status: map[String(instance.State?.Name)] || 'unknown',
      ipAddress: instance.PublicIpAddress || undefined,
    };
  }

  async createSnapshot(instanceId: string, _diskPath: string): Promise<{ snapshotId: string; sizeGb: number }> {
    // AWS snapshots a whole disk, not a folder, so diskPath isn't used. Our
    // machines have one disk — the root (boot) volume — and we snapshot it.
    const { region, id } = this.splitId(instanceId);
    const ec2 = this.ec2For(region);
    const instance = await this.describeInstance(region, id);
    if (!instance) throw new Error(`InvalidInstanceID.NotFound: ${id} doesn't exist in ${region}`);

    const rootMapping = (instance.BlockDeviceMappings || []).find((m) => m.DeviceName === instance.RootDeviceName)
      || instance.BlockDeviceMappings?.[0];
    const volumeId = rootMapping?.Ebs?.VolumeId;
    if (!volumeId) throw new Error(`Couldn't find the disk of ${id}`);

    const volumes = await ec2.describeVolumes({ VolumeIds: [volumeId] }).promise();
    const sizeGb = volumes.Volumes?.[0]?.Size || 0;

    await this.report('info', `Snapshotting the ${sizeGb} GB disk of ${id} (games and settings included)…`,
      'Stopping the machine first gives the most reliable snapshot.');
    const snap = await ec2.createSnapshot({
      VolumeId: volumeId,
      Description: `Gints Global Gaming Hubjob snapshot of ${id}`,
      TagSpecifications: [{ ResourceType: 'snapshot', Tags: tags(`cg-snap-${id}`, { SourceInstance: id }) }],
    }).promise();
    const snapshotId = snap.SnapshotId!;

    // The first snapshot of a disk copies everything and can take a while;
    // wait up to ~20 minutes (checking every 15 s), then carry on regardless.
    await this.report('info', `Snapshot ${snapshotId} started — waiting for AWS to finish copying (first snapshots of big disks can take 10+ minutes)…`);
    try {
      await ec2.waitFor('snapshotCompleted', { SnapshotIds: [snapshotId], $waiter: { delay: 15, maxAttempts: 80 } }).promise();
      await this.report('success', `Snapshot ${snapshotId} is complete.`);
    } catch {
      await this.report('warn', `Snapshot ${snapshotId} is still in progress at AWS. It will finish on its own — check its state later.`);
    }
    return { snapshotId: `${region}/${snapshotId}`, sizeGb };
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotInfo> {
    const { region, id } = this.splitId(snapshotId);
    const result = await this.ec2For(region).describeSnapshots({ SnapshotIds: [id] }).promise();
    const snap = result.Snapshots?.[0];
    if (!snap) throw new Error(`InvalidSnapshot.NotFound: ${id} doesn't exist in ${region}`);
    const state = String(snap.State);
    return {
      id: snapshotId,
      sizeGb: snap.VolumeSize || 0,
      state: state === 'completed' ? 'completed' : state === 'error' ? 'failed' : 'pending',
    };
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    const { region, id } = this.splitId(snapshotId);
    await this.report('info', `Deleting snapshot ${id} in ${region}…`);
    try {
      await this.ec2For(region).deleteSnapshot({ SnapshotId: id }).promise();
      await this.report('success', `Snapshot ${id} deleted.`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.report('warn', `Snapshot ${id} was already gone at AWS.`);
    }
  }

  /**
   * Create a new machine whose disk starts as a copy of a snapshot.
   *
   * AWS won't let you swap the root disk's snapshot when launching from an
   * ordinary image, so we: (1) register a temporary private image (AMI)
   * whose root disk IS the snapshot, (2) launch from it, (3) delete the
   * temporary image again (the snapshot itself is kept). If the snapshot is
   * in another region we first copy it there.
   */
  async restoreFromSnapshot(snapshotId: string, config: ProviderConfig): Promise<{ instanceId: string; ipAddress: string }> {
    let { region: snapRegion, id: snapId } = this.splitId(snapshotId);
    const region = config.region || snapRegion;

    if (snapRegion !== region) {
      await this.report('info', `The snapshot is in ${snapRegion}; copying it to ${region} first…`);
      const copy = await this.replicateSnapshot(snapshotId, 'aws', snapRegion, region);
      snapId = this.splitId(copy.snapshotId).id;
      snapRegion = region;
    }

    const ec2 = this.ec2For(region);
    await this.report('info', `Checking snapshot ${snapId} is ready…`);
    await ec2.waitFor('snapshotCompleted', { SnapshotIds: [snapId], $waiter: { delay: 15, maxAttempts: 120 } }).promise();
    const snaps = await ec2.describeSnapshots({ SnapshotIds: [snapId] }).promise();
    const sizeGb = snaps.Snapshots?.[0]?.VolumeSize || 150;

    // 1. Temporary image whose root disk is the snapshot.
    const rootDeviceName = '/dev/sda1'; // what Ubuntu images use
    await this.report('info', `Registering a temporary machine image from snapshot ${snapId}…`);
    const registered = await ec2.registerImage({
      Name: `cg-restore-${snapId}-${Date.now()}`,
      Description: 'Gints Global Gaming Hubjob temporary restore image (safe to delete)',
      Architecture: 'x86_64',
      VirtualizationType: 'hvm',
      EnaSupport: true, // g4dn/g5 need the ENA network driver flag
      RootDeviceName: rootDeviceName,
      BlockDeviceMappings: [{
        DeviceName: rootDeviceName,
        Ebs: { SnapshotId: snapId, VolumeType: 'gp3', DeleteOnTermination: true },
      }],
    }).promise();
    const imageId = registered.ImageId!;

    try {
      await ec2.waitFor('imageAvailable', { ImageIds: [imageId] }).promise();
      // 2. Launch from it. A fresh Sunshine login is generated; the setup
      //    script runs again (cloud-init runs user data for every NEW
      //    machine), skips what's already installed, and sets the new login.
      const { instanceId, ipAddress } = await this.createMachine({ ...config, region }, {
        spot: false,
        diskSizeGb: sizeGb,
        sunshineUsername: 'gamer',
        sunshinePassword: crypto.randomBytes(12).toString('base64url'),
        image: { imageId, rootDeviceName, label: `restore of ${snapId}` },
      });
      return { instanceId, ipAddress };
    } finally {
      // 3. The running machine no longer needs the image.
      await ec2.deregisterImage({ ImageId: imageId }).promise()
        .then(() => this.report('info', `Removed the temporary image ${imageId} (your snapshot is kept).`))
        .catch(() => this.report('warn', `Couldn't remove temporary image ${imageId} — delete it under EC2 → AMIs if you like (it costs nothing extra).`));
    }
  }

  async replicateSnapshot(
    sourceSnapshotId: string,
    sourceProvider: string,
    sourceRegion: string,
    targetRegion: string
  ): Promise<{ snapshotId: string }> {
    if (sourceProvider !== 'aws') {
      throw new FriendlyCloudError({
        code: 'CROSS_CLOUD_UNSUPPORTED',
        title: 'Copying snapshots from another cloud into AWS isn\'t supported yet',
        explanation: 'Each cloud stores disks in its own format; converting between them isn\'t built yet.',
        fixes: ['Launch a fresh machine on AWS instead.'],
      });
    }
    // The region inside our id wins; sourceRegion is the fallback for bare ids.
    const parsed = this.splitId(sourceSnapshotId);
    const fromRegion = sourceSnapshotId.includes('/') ? parsed.region : (sourceRegion || parsed.region);
    if (fromRegion === targetRegion) return { snapshotId: `${fromRegion}/${parsed.id}` };

    // CopySnapshot is sent to the DESTINATION region, which pulls the copy in.
    // (The SDK signs the cross-region "presigned URL" part automatically.)
    await this.report('info', `Copying snapshot ${parsed.id} from ${fromRegion} to ${targetRegion} (billed as data transfer between regions)…`);
    const result = await this.ec2For(targetRegion).copySnapshot({
      SourceRegion: fromRegion,
      SourceSnapshotId: parsed.id,
      Description: `Gints Global Gaming Hubjob copy of ${parsed.id} from ${fromRegion}`,
      TagSpecifications: [{ ResourceType: 'snapshot', Tags: tags(`cg-copy-${parsed.id}`, { SourceSnapshot: parsed.id, SourceRegion: fromRegion }) }],
    }).promise();
    if (!result.SnapshotId) throw new Error('AWS accepted the copy but returned no snapshot id');
    await this.report('success', `Copy ${result.SnapshotId} started in ${targetRegion}; it becomes usable once AWS finishes copying.`);
    return { snapshotId: `${targetRegion}/${result.SnapshotId}` };
  }

  async getRegions(): Promise<RegionData[]> {
    return AWS_REGIONS.map((r) => ({
      provider: 'aws',
      name: r.name,
      region: r.id,
      lat: r.lat,
      lng: r.lng,
      onDemandPrice: estimateHourly('g4dn.xlarge', r.id),
      spotPrice: estimateHourly('g4dn.xlarge', r.id, true),
      egressCostPerGb: r.egressPerGb,
    }));
  }

  async getInstanceCost(region: string, instanceType: string, spot?: boolean): Promise<{ onDemandPrice: number; spotPrice?: number }> {
    return {
      onDemandPrice: estimateHourly(instanceType, region),
      spotPrice: spot ? estimateHourly(instanceType, region, true) : undefined,
    };
  }

  async getEgressCostPerGb(region: string): Promise<number> {
    return findRegion(region)?.egressPerGb ?? 0.12;
  }

  /**
   * What was actually spent, from AWS Cost Explorer, split into compute,
   * data-out and storage by "usage type". Notes:
   * - It covers the whole AWS ACCOUNT, not just our machines (userId is unused).
   * - AWS charges $0.01 per Cost Explorer request, and data lags ~24 hours.
   * - Cost Explorer must have been opened once in the console to switch it on.
   */
  async queryCosts(_userId: string, startDate: Date, endDate: Date): Promise<{ computeCost: number; egressCost: number; storageCost: number }> {
    // Cost Explorer only lives in us-east-1, whatever region you use.
    const ce = new AWS.CostExplorer(this.clientConfig('us-east-1'));
    const day = (d: Date) => d.toISOString().slice(0, 10); // "2026-09-27"
    const start = day(startDate);
    let end = day(endDate);
    if (end <= start) end = day(new Date(startDate.getTime() + 24 * 3600 * 1000)); // End is exclusive and must be later

    let computeCost = 0;
    let egressCost = 0;
    let storageCost = 0;
    try {
      let token: string | undefined;
      do {
        const result = await ce.getCostAndUsage({
          TimePeriod: { Start: start, End: end },
          Granularity: 'MONTHLY',
          Metrics: ['UnblendedCost'],
          GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
          NextPageToken: token,
        }).promise();
        for (const period of result.ResultsByTime || []) {
          for (const group of period.Groups || []) {
            // Usage types look like "APS1-BoxUsage:g4dn.xlarge",
            // "APS1-SpotUsage:g5.xlarge", "APS1-DataTransfer-Out-Bytes",
            // "APS1-EBS:VolumeUsage.gp3", "APS1-EBS:SnapshotUsage".
            const usage = String(group.Keys?.[0] || '');
            const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || '0') || 0;
            if (/BoxUsage|SpotUsage|DedicatedUsage/.test(usage)) computeCost += cost;
            else if (/DataTransfer-Out|DataTransfer-Regional|AWS-Out-Bytes/.test(usage)) egressCost += cost;
            else if (/EBS:/.test(usage)) storageCost += cost;
          }
        }
        token = result.NextPageToken;
      } while (token);
    } catch (error: any) {
      if (/DataUnavailable|not enabled|opt.?in/i.test(`${error?.code} ${error?.message}`)) {
        throw new FriendlyCloudError({
          code: 'AWS_COSTS_UNAVAILABLE',
          title: 'AWS Cost Explorer isn\'t switched on yet',
          explanation: 'Real spend comes from AWS Cost Explorer, which has to be opened once in the console before its data is available (up to 24 hours later).',
          fixes: ['Open Cost Explorer in the AWS console once (button below), then try again tomorrow.', 'Until then, costs shown here are estimates from running time.'],
          consoleUrl: AWS_CONSOLE.costExplorer,
          consoleLabel: 'Open Cost Explorer',
        });
      }
      throw error; // e.g. AccessDenied -> the AWS_PERMISSION card names ce:GetCostAndUsage
    }
    const round = (n: number) => Math.round(n * 100) / 100;
    return { computeCost: round(computeCost), egressCost: round(egressCost), storageCost: round(storageCost) };
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.getCallerIdentity();
      return true;
    } catch (error: any) {
      // Log only the error code/message — never the key itself.
      console.error('[AWS] credential check failed:', error?.code || '', error?.message);
      return false;
    }
  }

  /**
   * Read the machine's serial console and extract the setup stages printed
   * by the setup script. Returns [] if nothing is available yet (AWS may
   * take a minute or two to start collecting console output).
   */
  async getSetupProgress(instanceId: string): Promise<SetupStage[]> {
    try {
      const { region, id } = this.splitId(instanceId);
      // Latest: true = the most recent output (supported on Nitro machines like g4dn/g5).
      const result = await this.ec2For(region).getConsoleOutput({ InstanceId: id, Latest: true }).promise();
      const text = Buffer.from(result.Output || '', 'base64').toString('utf8');
      return parseSetupStages(text);
    } catch {
      return [];
    }
  }

  // ==========================================================================
  // Inventory (the infrastructure map)
  // ==========================================================================

  /**
   * Everything Gints Global Gaming Hubjob has created in this AWS account, in every
   * region of our catalog: machines, their disks (EBS volumes), snapshots,
   * the streaming security group and any Elastic IPs — each with an
   * estimated cost, and "orphans" (things that still cost money but belong
   * to no machine) flagged with a plain-English reason.
   *
   * HOW WE FIND OUR THINGS
   *   Everything we create carries the tag app=cloudgaming-hub (RESOURCE_TAG)
   *   plus a Name — see tags() and createMachine(), which tags the machine
   *   AND its boot disk. As a safety net for disks made before the disk was
   *   tagged, we also pick up any volume attached to one of our machines.
   *
   * SPEED
   *   All regions are asked at the same time (Promise.allSettled), and inside
   *   a region the lookups run side by side too: a handful of list calls per
   *   region, never one call per item.
   *
   * ERRORS
   *   A region that fails (usually one the account hasn't switched on — AWS
   *   answers "AuthFailure"/"OptInRequired") is skipped so the rest still
   *   show. If EVERY region fails, it's the key itself (wrong secret, missing
   *   permission...), so we throw the first error and the caller turns it
   *   into a friendly card. Finding nothing is not an error: we return [].
   */
  async listResources(): Promise<InventoryItem[]> {
    const results = await Promise.allSettled(AWS_REGIONS.map((r) => this.listRegionResources(r.id)));

    const items: InventoryItem[] = [];
    const failures: Array<{ region: string; error: any }> = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') items.push(...result.value);
      else failures.push({ region: AWS_REGIONS[index].id, error: result.reason });
    });

    // Every single region failed -> the credentials/permissions are the problem.
    if (failures.length === AWS_REGIONS.length && failures.length > 0) throw failures[0].error;

    for (const { region, error } of failures) {
      if (isRegionUnavailable(error)) continue; // region not switched on for this account — nothing of ours can be there
      // Anything else (throttling, a network blip) — note it in the server log
      // and show the other regions rather than failing the whole map.
      console.warn(`[AWS] inventory: skipped ${region}:`, error?.code || '', error?.message);
    }
    return items;
  }

  /**
   * Keep asking an AWS "describe" call for the next page until there are
   * no more. `call` gets the NextToken of the previous page (undefined first).
   */
  private async allPages<R extends { NextToken?: string }>(call: (token?: string) => Promise<R>): Promise<R[]> {
    const pages: R[] = [];
    let token: string | undefined;
    do {
      const page = await call(token);
      pages.push(page);
      token = page.NextToken;
    } while (token);
    return pages;
  }

  /** Everything of ours in ONE region (see listResources). */
  private async listRegionResources(region: string): Promise<InventoryItem[]> {
    const ec2 = this.ec2For(region);
    const ourTag = [{ Name: `tag:${RESOURCE_TAG.key}`, Values: [RESOURCE_TAG.value] }];
    const consoleBase = `https://${region}.console.aws.amazon.com/ec2/home?region=${region}`;

    // The five list calls, all at once. Filters do the searching at AWS's end.
    const [instancePages, taggedVolumePages, snapshotPages, groupResult, addressResult] = await Promise.all([
      // Machines in every state except "terminated" (deleted machines linger
      // in the list for about an hour, costing nothing).
      this.allPages((NextToken) => ec2.describeInstances({
        Filters: [...ourTag, { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped', 'shutting-down'] }],
        NextToken,
      }).promise()),
      this.allPages((NextToken) => ec2.describeVolumes({ Filters: ourTag, NextToken }).promise()),
      // OwnerIds 'self' = only snapshots this account made (not public ones).
      this.allPages((NextToken) => ec2.describeSnapshots({ OwnerIds: ['self'], Filters: ourTag, NextToken }).promise()),
      // The streaming firewall, found by its fixed name.
      ec2.describeSecurityGroups({ Filters: [{ Name: 'group-name', Values: [STREAMING_FIREWALL_NAME] }] }).promise(),
      ec2.describeAddresses({ Filters: ourTag }).promise(),
    ]);

    const items: InventoryItem[] = [];

    // ---- Machines ---------------------------------------------------------
    // AWS groups instances into "reservations" (the request that launched
    // them), so they're nested one level deep.
    const instances = instancePages.flatMap((p) => (p.Reservations || []).flatMap((r) => r.Instances || []));
    const ourInstanceIds = new Set<string>();
    for (const instance of instances) {
      if (!instance.InstanceId) continue;
      ourInstanceIds.add(instance.InstanceId);
      const spot = instance.InstanceLifecycle === 'spot';
      const hourly = estimateHourly(String(instance.InstanceType), region, spot);
      items.push({
        provider: 'aws',
        type: 'vm',
        id: `${region}/${instance.InstanceId}`,
        name: tagValue(instance.Tags, 'Name') || instance.InstanceId,
        region,
        zone: instance.Placement?.AvailabilityZone,
        status: String(instance.State?.Name || 'unknown'), // 'running', 'stopped', 'pending'...
        instanceId: `${region}/${instance.InstanceId}`, // same format as machines.instance_id
        hourlyCost: hourly || undefined, // 0 = a machine type our catalog doesn't know
        consoleUrl: `${consoleBase}#InstanceDetails:instanceId=${instance.InstanceId}`,
        createdAt: iso(instance.LaunchTime),
      });
    }

    // ---- Disks (EBS volumes) ----------------------------------------------
    // Tagged volumes, plus (safety net) untagged ones attached to our
    // machines. The second lookup is one call for the whole region, and only
    // if some machine's disk wasn't already in the tagged list.
    const volumes = taggedVolumePages.flatMap((p) => p.Volumes || []);
    const seenVolumeIds = new Set(volumes.map((v) => v.VolumeId));
    const untaggedDiskOwners = instances
      .filter((i) => (i.BlockDeviceMappings || []).some((m) => m.Ebs?.VolumeId && !seenVolumeIds.has(m.Ebs.VolumeId)))
      .map((i) => i.InstanceId!);
    if (untaggedDiskOwners.length) {
      const extraPages = await this.allPages((NextToken) => ec2.describeVolumes({
        Filters: [{ Name: 'attachment.instance-id', Values: untaggedDiskOwners }],
        NextToken,
      }).promise());
      for (const volume of extraPages.flatMap((p) => p.Volumes || [])) {
        if (!seenVolumeIds.has(volume.VolumeId)) {
          seenVolumeIds.add(volume.VolumeId);
          volumes.push(volume);
        }
      }
    }

    for (const volume of volumes) {
      if (!volume.VolumeId) continue;
      const attachedInstance = volume.Attachments?.find((a) => a.InstanceId)?.InstanceId;
      const sizeGb = volume.Size || 0;
      // 'available' = exists but plugged into nothing: still billed per GB.
      const unattached = volume.State === 'available';
      items.push({
        provider: 'aws',
        type: 'disk',
        id: `${region}/${volume.VolumeId}`,
        name: tagValue(volume.Tags, 'Name') || volume.VolumeId,
        region,
        zone: volume.AvailabilityZone,
        status: String(volume.State || 'unknown'), // 'in-use', 'available', 'creating', 'deleting'...
        attachedTo: attachedInstance ? `${region}/${attachedInstance}` : undefined,
        sizeGb,
        // Our catalog's gp3 price; other disk types are close enough for an estimate.
        monthlyCost: cents(sizeGb * AWS_CATALOG.diskPerGbMonth),
        orphan: unattached || undefined,
        orphanReason: unattached ? 'Disk not attached to any machine — still billed monthly' : undefined,
        consoleUrl: `${consoleBase}#VolumeDetails:volumeId=${volume.VolumeId}`,
        createdAt: iso(volume.CreateTime),
      });
    }

    // ---- Snapshots (backups) ------------------------------------------------
    // A snapshot is a leftover when the disk it was taken from is gone — i.e.
    // the machine was deleted but its backup wasn't. (It may still be wanted,
    // e.g. to restore later — "orphan" here just means "no machine".)
    for (const snap of snapshotPages.flatMap((p) => p.Snapshots || [])) {
      if (!snap.SnapshotId) continue;
      const sizeGb = snap.VolumeSize || 0;
      const sourceInstance = tagValue(snap.Tags, 'SourceInstance');
      // Copies made by replicateSnapshot() point at a placeholder volume
      // ("vol-ffffffff"), so for them only the source instance tells us anything.
      const sourceDiskExists = !!snap.VolumeId && seenVolumeIds.has(snap.VolumeId);
      const sourceMachineExists = !!sourceInstance && ourInstanceIds.has(sourceInstance);
      const isCopy = !!tagValue(snap.Tags, 'SourceSnapshot');
      const orphan = !sourceDiskExists && !sourceMachineExists && !isCopy;
      items.push({
        provider: 'aws',
        type: 'snapshot',
        id: `${region}/${snap.SnapshotId}`, // same format as our snapshot records
        name: tagValue(snap.Tags, 'Name') || snap.SnapshotId,
        region,
        status: String(snap.State || 'unknown'), // 'pending', 'completed', 'error'
        attachedTo: sourceMachineExists ? `${region}/${sourceInstance}` : undefined,
        sizeGb,
        // Billed on the data actually stored, which is at most the disk size
        // (usually less) — so this is an upper-end estimate.
        monthlyCost: cents(sizeGb * SNAPSHOT_PER_GB_MONTH),
        orphan: orphan || undefined,
        orphanReason: orphan ? 'Backup of a deleted machine — still billed monthly' : undefined,
        consoleUrl: `${consoleBase}#SnapshotDetails:snapshotId=${snap.SnapshotId}`,
        createdAt: iso(snap.StartTime),
      });
    }

    // ---- Firewall (security group) ------------------------------------------
    // Free; one per region we've launched in. (There's normally only one, in
    // the default VPC; we list whatever carries the name.)
    for (const group of groupResult.SecurityGroups || []) {
      if (!group.GroupId) continue;
      items.push({
        provider: 'aws',
        type: 'firewall',
        id: `${region}/${group.GroupId}`,
        name: group.GroupName || STREAMING_FIREWALL_NAME,
        region,
        status: 'active',
        consoleUrl: `${consoleBase}#SecurityGroup:groupId=${group.GroupId}`,
      });
    }

    // ---- Elastic IPs ----------------------------------------------------------
    // We don't create these today (machines get an automatic public IP), but
    // list any tagged ones: an unattached Elastic IP is billed for nothing.
    for (const address of addressResult.Addresses || []) {
      const key = address.AllocationId || address.PublicIp;
      if (!key) continue;
      const unattached = !address.AssociationId && !address.InstanceId && !address.NetworkInterfaceId;
      items.push({
        provider: 'aws',
        type: 'public-ip',
        id: `${region}/${key}`,
        name: tagValue(address.Tags, 'Name') || address.PublicIp || key,
        region,
        status: unattached ? 'available' : 'in-use',
        attachedTo: address.InstanceId ? `${region}/${address.InstanceId}` : undefined,
        monthlyCost: cents(PUBLIC_IPV4_PER_HOUR * 730), // ~730 hours in a month
        orphan: unattached || undefined,
        orphanReason: unattached ? 'Elastic IP not attached to any machine — still billed hourly' : undefined,
        consoleUrl: address.AllocationId ? `${consoleBase}#ElasticIpDetails:AllocationId=${address.AllocationId}` : `${consoleBase}#Addresses:`,
      });
    }

    return items;
  }

  // ==========================================================================
  // AWS-specific extras (used by the credential checks and machine pages)
  // ==========================================================================

  /** Who does this key belong to? Throws if AWS rejects the key. */
  async getCallerIdentity(): Promise<{ accountId: string; arn: string }> {
    const sts = new AWS.STS(this.clientConfig(this.defaultRegion));
    const who = await sts.getCallerIdentity({}).promise();
    return { accountId: String(who.Account || ''), arn: String(who.Arn || '') };
  }

  /**
   * Ask EC2 "WOULD this launch be allowed?" without launching anything
   * (DryRun). AWS answers with an error either way: "DryRunOperation" means
   * yes, "UnauthorizedOperation" means the key lacks permission.
   * Returns 'allowed', or throws the real error.
   */
  async dryRunLaunch(region: string, instanceType = 'g4dn.xlarge'): Promise<'allowed'> {
    const ami = await this.findUbuntuAmi(region);
    try {
      await this.ec2For(region).runInstances({
        DryRun: true,
        ImageId: ami.imageId,
        InstanceType: instanceType,
        MinCount: 1,
        MaxCount: 1,
      }).promise();
      return 'allowed'; // (not expected: DryRun always "fails" one way or the other)
    } catch (error: any) {
      if (error?.code === 'DryRunOperation') return 'allowed';
      throw error;
    }
  }

  /** A Service Quotas value for EC2 in a region (e.g. 'L-DB2E81BA' = on-demand G and VT vCPUs). */
  async getEc2Quota(region: string, quotaCode: string): Promise<number> {
    const sq = new AWS.ServiceQuotas(this.clientConfig(region));
    try {
      const result = await sq.getServiceQuota({ ServiceCode: 'ec2', QuotaCode: quotaCode }).promise();
      return Number(result.Quota?.Value) || 0;
    } catch (error) {
      // An account that never changed a quota may only have the AWS default.
      if (/NoSuchResource/i.test(String((error as any)?.code))) {
        const fallback = await sq.getAWSDefaultServiceQuota({ ServiceCode: 'ec2', QuotaCode: quotaCode }).promise();
        return Number(fallback.Quota?.Value) || 0;
      }
      throw error;
    }
  }

  /** Does this region have a default VPC to launch into? */
  async hasDefaultVpc(region: string): Promise<boolean> {
    const vpcs = await this.ec2For(region).describeVpcs({ Filters: [{ Name: 'is-default', Values: ['true'] }] }).promise();
    return !!vpcs.Vpcs?.length;
  }

  /**
   * The Sunshine admin login baked into the machine's user data, plus its
   * IP. (User data is only readable with the user's own AWS key.)
   */
  async getConnectionInfo(instanceId: string): Promise<{ ipAddress: string; username?: string; password?: string; status: string }> {
    const { region, id } = this.splitId(instanceId);
    const ec2 = this.ec2For(region);
    const instance = await this.describeInstance(region, id);
    const attr = await ec2.describeInstanceAttribute({ InstanceId: id, Attribute: 'userData' }).promise();
    // User data may be gzip-compressed (see createMachine); unpack if so.
    const raw = Buffer.from(attr.UserData?.Value || '', 'base64');
    const script = (raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw).toString('utf8');
    return {
      ipAddress: instance?.PublicIpAddress || '',
      username: script.match(/^SUN_USER='([^']*)'/m)?.[1],
      // The setup script stores the password base64-encoded (SUN_PASS_B64).
      password: (() => {
        const b64 = script.match(/^SUN_PASS_B64='([^']*)'/m)?.[1];
        return b64 ? Buffer.from(b64, 'base64').toString('utf8') : undefined;
      })(),
      status: String(instance?.State?.Name || 'terminated'),
    };
  }
}
