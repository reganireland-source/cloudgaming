/**
 * ============================================================================
 * src/providers/GCPProvider.ts — GOOGLE CLOUD (GCP)
 * ============================================================================
 *
 * The Google Cloud version of the CloudProvider contract (Provider.ts). It
 * creates, starts, stops, deletes and snapshots GPU virtual machines in the
 * USER'S OWN Google Cloud project, using the service-account key they added
 * on the Config page (stored encrypted — see CredentialService.ts).
 *
 * KEY IDEAS
 * ---------
 * - ZONES: Google machines live in a ZONE (asia-southeast1-a, -b, -c...),
 *   not just a region. GPUs sell out per zone, so launching tries each zone
 *   of the chosen region in turn until one works.
 * - OUR INSTANCE ID is "zone/name", e.g. "asia-southeast1-b/cg-3f1c9e2a",
 *   because every later call (stop, start...) needs to know the zone too.
 * - LONG-RUNNING OPERATIONS: most Google calls return an "operation"
 *   immediately and finish later. waitZoneOp/waitGlobalOp poll until done
 *   and turn a failed operation into an Error.
 * - NO SSH: the machine configures itself with a startup script
 *   (shared/setupScript.ts). We watch its progress through the serial console.
 * - CHATTY: every step calls this.report(...), which (when a reporter is
 *   attached) writes a line into the operation log the frontend shows live.
 *
 * CREDENTIALS SHAPE
 * -----------------
 *   { projectId: 'my-project-123', serviceAccountKey: { ...the JSON key file... } }
 * serviceAccountKey may also be the JSON as text.
 * ============================================================================
 */

import crypto from 'crypto';
import compute from '@google-cloud/compute';
import { CloudProvider, ProviderConfig, LaunchOptions, SnapshotInfo } from './Provider';
import { RegionData } from '../types';
import type { InventoryItem } from './shared/types';
import { FriendlyCloudError, isZoneSpecificError, toFriendlyError } from './gcp/errors';
import {
  BOOT_IMAGE,
  BALANCED_DISK_PER_GB_MONTH,
  SNAPSHOT_PER_GB_MONTH,
  DEFAULT_REGION,
  FIREWALL_RULE_NAME,
  NETWORK_NAME,
  subnetCidrFor,
  GCP_REGIONS,
  GCP_SHAPES,
  NETWORK_TAG,
  SUNSHINE_TCP_PORTS,
  SUNSHINE_UDP_PORTS,
  estimateHourly,
  findRegion,
  findShape,
} from './gcp/catalog';
import { buildSetupScript, parseSetupStages, SetupStage } from './shared/setupScript';

/** The parsed, checked credentials. */
export interface GcpCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

// Google's operation status "DONE" (as text via REST, or its enum number).
const DONE = new Set<unknown>(['DONE', 2104194]);
const OPERATION_TIMEOUT_MS = 10 * 60 * 1000; // give up waiting after 10 minutes

/** Is this a "does not exist" error from Google? */
function isNotFound(error: any): boolean {
  return error?.code === 404 || error?.code === 5 || /not found|was not found|NOT_FOUND/i.test(String(error?.message));
}

export class GCPProvider extends CloudProvider {
  name = 'gcp' as const;
  readonly selfConfiguring = true;

  readonly projectId: string;
  readonly clientEmail: string;

  // One client per Google API area. `any` keeps the SDK's very large types
  // out of our way; the calls below follow Google's documented shapes.
  private instances: any;
  private zoneOps: any;
  private globalOps: any;
  private firewalls: any;
  private disks: any;
  private snapshots: any;
  private projects: any;
  private regions: any;
  private networks: any;
  private subnetworks: any;
  private regionOps: any;

  /**
   * Turn whatever was stored into checked credentials, or throw a friendly
   * error explaining exactly what's wrong with them.
   */
  static parseCredentials(raw: any): GcpCredentials {
    let key = raw?.serviceAccountKey ?? raw;
    if (typeof key === 'string') {
      try {
        key = JSON.parse(key);
      } catch {
        throw new FriendlyCloudError({
          code: 'GCP_KEY_NOT_JSON',
          title: 'The service account key isn\'t valid JSON',
          explanation: 'It looks like only part of the key file was pasted, or it was changed while copying.',
          fixes: [
            'Open the downloaded .json file in a text editor (or use "Upload file" on the Config page).',
            'Copy EVERYTHING from the first { to the last } and paste it again.',
          ],
        });
      }
    }
    if (!key || key.type !== 'service_account' || !key.client_email || !key.private_key) {
      throw new FriendlyCloudError({
        code: 'GCP_KEY_WRONG_TYPE',
        title: 'That isn\'t a service account key file',
        explanation:
          'A service account key has "type": "service_account", plus "client_email" and "private_key" fields. This one is missing some of them.',
        fixes: [
          'In Google Cloud: IAM & Admin → Service Accounts → your account → Keys → Add key → Create new key → JSON.',
          'Use the file that downloads — not an API key, OAuth client file or gcloud config.',
        ],
      });
    }
    const projectId = String(raw?.projectId || key.project_id || '').trim();
    if (!projectId) {
      throw new FriendlyCloudError({
        code: 'GCP_NO_PROJECT',
        title: 'No project ID',
        explanation: 'We need to know which Google Cloud project to create machines in.',
        fixes: ['Enter the Project ID (e.g. my-gaming-412305) — it\'s also the "project_id" inside the key file.'],
      });
    }
    return { projectId, clientEmail: key.client_email, privateKey: key.private_key };
  }

  constructor(credentials: any) {
    super();
    const creds = GCPProvider.parseCredentials(credentials);
    this.projectId = creds.projectId;
    this.clientEmail = creds.clientEmail;

    // Every client gets the same login. Google's library signs requests
    // with the private key; nothing is written to disk.
    const opts = {
      projectId: creds.projectId,
      credentials: { client_email: creds.clientEmail, private_key: creds.privateKey },
    };
    this.instances = new compute.InstancesClient(opts);
    this.zoneOps = new compute.ZoneOperationsClient(opts);
    this.globalOps = new compute.GlobalOperationsClient(opts);
    this.firewalls = new compute.FirewallsClient(opts);
    this.disks = new compute.DisksClient(opts);
    this.snapshots = new compute.SnapshotsClient(opts);
    this.projects = new compute.ProjectsClient(opts);
    this.regions = new compute.RegionsClient(opts);
    this.networks = new compute.NetworksClient(opts);
    this.subnetworks = new compute.SubnetworksClient(opts);
    this.regionOps = new compute.RegionOperationsClient(opts);
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /** "asia-southeast1-b/cg-abc" -> { zone: 'asia-southeast1-b', name: 'cg-abc' } */
  private splitId(instanceId: string): { zone: string; name: string } {
    const [zone, name] = instanceId.split('/');
    if (!zone || !name) throw new Error(`Not a GCP instance id (expected "zone/name"): ${instanceId}`);
    return { zone, name };
  }

  /** Throw a readable Error if a finished Google operation reports errors. */
  private throwIfOperationFailed(operation: any): void {
    const errors = operation?.error?.errors;
    if (errors && errors.length) {
      const text = errors.map((e: any) => `${e.code}: ${e.message}`).join('; ');
      const err: any = new Error(text);
      err.gcpCode = errors[0].code;
      throw err;
    }
  }

  /**
   * Wait for a ZONE operation (anything about one machine or disk) to finish.
   * `wait` blocks on Google's side for up to ~2 minutes per call, so this
   * loop usually runs only once or twice.
   */
  private async waitZoneOp(lro: any, zone: string): Promise<void> {
    let operation = lro?.latestResponse ?? lro;
    const started = Date.now();
    while (!DONE.has(operation?.status)) {
      if (Date.now() - started > OPERATION_TIMEOUT_MS) {
        throw new Error(`Timed out after 10 minutes waiting for Google operation ${operation?.name}`);
      }
      [operation] = await this.zoneOps.wait({ operation: operation.name, project: this.projectId, zone });
    }
    this.throwIfOperationFailed(operation);
  }

  /** Same, for GLOBAL operations (firewall rules, snapshots). */
  private async waitGlobalOp(lro: any): Promise<void> {
    let operation = lro?.latestResponse ?? lro;
    const started = Date.now();
    while (!DONE.has(operation?.status)) {
      if (Date.now() - started > OPERATION_TIMEOUT_MS) {
        throw new Error(`Timed out after 10 minutes waiting for Google operation ${operation?.name}`);
      }
      [operation] = await this.globalOps.wait({ operation: operation.name, project: this.projectId });
    }
    this.throwIfOperationFailed(operation);
  }

  /** The public IP of a machine resource, if it has one. */
  private natIp(instance: any): string {
    return instance?.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP || '';
  }

  /** Same as waitZoneOp, for REGION operations (subnets). */
  private async waitRegionOp(lro: any, region: string): Promise<void> {
    let operation = lro?.latestResponse ?? lro;
    const started = Date.now();
    while (!DONE.has(operation?.status)) {
      if (Date.now() - started > OPERATION_TIMEOUT_MS) {
        throw new Error(`Timed out after 10 minutes waiting for Google operation ${operation?.name}`);
      }
      [operation] = await this.regionOps.wait({ operation: operation.name, project: this.projectId, region });
    }
    this.throwIfOperationFailed(operation);
  }

  /**
   * Make sure our own network and this region's subnet exist (CloudyPad does
   * the same). Relying on the project's "default" network fails in
   * organisations whose policy skips creating it.
   */
  private async ensureNetwork(region: string): Promise<void> {
    try {
      await this.networks.get({ project: this.projectId, network: NETWORK_NAME });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.report('info', `Creating a private network "${NETWORK_NAME}" for your gaming machines (one-time)…`);
      const [lro] = await this.networks.insert({
        project: this.projectId,
        networkResource: {
          name: NETWORK_NAME,
          autoCreateSubnetworks: false,
          description: 'CloudGaming Hub: network for gaming machines',
        },
      });
      await this.waitGlobalOp(lro);
    }
    const subnet = `cloudgaming-${region}`;
    try {
      await this.subnetworks.get({ project: this.projectId, region, subnetwork: subnet });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.report('info', `Creating subnet "${subnet}" (${subnetCidrFor(region)}) in ${region} (one-time)…`);
      const [lro] = await this.subnetworks.insert({
        project: this.projectId,
        region,
        subnetworkResource: {
          name: subnet,
          network: `global/networks/${NETWORK_NAME}`,
          ipCidrRange: subnetCidrFor(region),
          region,
        },
      });
      await this.waitRegionOp(lro, region);
    }
  }

  /**
   * Make sure the firewall rule that opens the streaming ports exists.
   * Created once per project; machines opt in via their network tag.
   */
  private async ensureFirewall(): Promise<void> {
    try {
      await this.firewalls.get({ project: this.projectId, firewall: FIREWALL_RULE_NAME });
      await this.report('info', `Firewall rule "${FIREWALL_RULE_NAME}" already exists — streaming ports are open.`);
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await this.report('info', `Creating firewall rule "${FIREWALL_RULE_NAME}" to open the streaming ports (one-time)…`,
      `TCP ${SUNSHINE_TCP_PORTS.join(', ')} · UDP ${SUNSHINE_UDP_PORTS.join(', ')}`);
    const [lro] = await this.firewalls.insert({
      project: this.projectId,
      firewallResource: {
        name: FIREWALL_RULE_NAME,
        network: `global/networks/${NETWORK_NAME}`,
        direction: 'INGRESS',
        description: 'CloudGaming Hub: Sunshine/Moonlight streaming ports',
        sourceRanges: ['0.0.0.0/0'],
        targetTags: [NETWORK_TAG],
        allowed: [
          { IPProtocol: 'tcp', ports: SUNSHINE_TCP_PORTS },
          { IPProtocol: 'udp', ports: SUNSHINE_UDP_PORTS },
        ],
      },
    });
    await this.waitGlobalOp(lro);
    await this.report('success', 'Firewall rule created.');
  }

  /**
   * Create one machine, trying each zone of the region until one works.
   * Shared by launchInstance (fresh Ubuntu disk) and restoreFromSnapshot
   * (disk copied from a snapshot).
   */
  private async createMachine(
    config: ProviderConfig,
    options: { spot: boolean; diskSizeGb: number; sourceSnapshot?: string;
               sunshineUsername: string; sunshinePassword: string; autoStopMinutes?: number }
  ): Promise<{ instanceId: string; ipAddress: string; costPerHour: number }> {
    const shape = findShape(config.instanceType);
    if (!shape) {
      throw new FriendlyCloudError({
        code: 'UNKNOWN_SHAPE',
        title: `Unknown machine type "${config.instanceType}"`,
        explanation: 'This machine type isn\'t one CloudGaming Hub knows how to launch on Google Cloud.',
        fixes: [`Choose one of: ${GCP_SHAPES.map((s) => s.label).join(', ')}.`],
      });
    }
    const region = findRegion(config.region);
    if (!region) {
      throw new FriendlyCloudError({
        code: 'UNKNOWN_REGION',
        title: `Unsupported region "${config.region}"`,
        explanation: 'We only launch in regions where Google offers T4 or L4 GPUs.',
        fixes: [`Choose one of: ${GCP_REGIONS.map((r) => `${r.name} (${r.id})`).join(', ')}.`],
      });
    }
    if (!region.gpus.includes(shape.gpuModel)) {
      throw new FriendlyCloudError({
        code: 'GPU_NOT_IN_REGION',
        title: `${shape.gpuModel} GPUs aren't offered in ${region.name}`,
        explanation: `Google doesn't sell ${shape.gpuModel} GPUs in ${region.id}.`,
        fixes: [`Pick a ${region.gpus.join(' or ')} machine, or another region.`],
      });
    }

    await this.report('info', `Project ${this.projectId} · ${shape.label} · ${region.name} (${region.id})` +
      `${options.spot ? ' · SPOT (cheaper, can be interrupted)' : ''}`);
    await this.ensureNetwork(region.id);
    await this.ensureFirewall();

    // A unique, Google-legal name: lowercase letters, digits, hyphens.
    const name = `cg-${crypto.randomBytes(4).toString('hex')}`;
    const zoneErrors: string[] = [];

    for (const letter of region.zones) {
      const zone = `${region.id}-${letter}`;
      await this.report('info', `Trying zone ${zone}…`);

      const resource: any = {
        name,
        machineType: `zones/${zone}/machineTypes/${shape.machineType}`,
        labels: { app: 'cloudgaming-hub' },
        tags: { items: [NETWORK_TAG] },
        disks: [
          {
            boot: true,
            autoDelete: true,
            deviceName: name,
            initializeParams: {
              diskName: name,
              // Label the disk too (not just the machine), so the inventory
              // map can find it — e.g. if it's ever left behind on its own.
              labels: { app: 'cloudgaming-hub' },
              diskSizeGb: String(options.diskSizeGb),
              diskType: `zones/${zone}/diskTypes/pd-balanced`,
              ...(options.sourceSnapshot
                ? { sourceSnapshot: options.sourceSnapshot }
                : { sourceImage: BOOT_IMAGE }),
            },
          },
        ],
        networkInterfaces: [
          {
            network: `global/networks/${NETWORK_NAME}`,
            subnetwork: `regions/${region.id}/subnetworks/cloudgaming-${region.id}`,
            accessConfigs: [{ name: 'External NAT', type: 'ONE_TO_ONE_NAT', networkTier: 'PREMIUM' }],
          },
        ],
        // GPU machines can't be live-migrated during Google maintenance, so
        // they must be allowed to stop ("TERMINATE") instead.
        scheduling: options.spot
          ? { onHostMaintenance: 'TERMINATE', automaticRestart: false, provisioningModel: 'SPOT', instanceTerminationAction: 'STOP' }
          : { onHostMaintenance: 'TERMINATE', automaticRestart: true, provisioningModel: 'STANDARD' },
        metadata: {
          items: [
            { key: 'startup-script', value: buildSetupScript({ sunshineUsername: options.sunshineUsername, sunshinePassword: options.sunshinePassword, autoStopMinutes: options.autoStopMinutes }) },
            { key: 'sunshine-username', value: options.sunshineUsername },
            { key: 'sunshine-password', value: options.sunshinePassword },
          ],
        },
      };
      if (shape.gpuType) {
        resource.guestAccelerators = [
          { acceleratorCount: 1, acceleratorType: `zones/${zone}/acceleratorTypes/${shape.gpuType}` },
        ];
      }

      try {
        const [lro] = await this.instances.insert({ project: this.projectId, zone, instanceResource: resource });
        await this.report('info', `Google accepted the request — creating the machine in ${zone} (usually 20–60 s)…`);
        await this.waitZoneOp(lro, zone);

        const [instance] = await this.instances.get({ project: this.projectId, zone, instance: name });
        const ipAddress = this.natIp(instance);
        await this.report('success', `Machine ${name} created in ${zone}${ipAddress ? ` with public IP ${ipAddress}` : ''}.`);
        return {
          instanceId: `${zone}/${name}`,
          ipAddress,
          costPerHour: estimateHourly(shape.id, region.id, options.spot),
        };
      } catch (error: any) {
        if (isZoneSpecificError(error)) {
          const friendly = toFriendlyError(error, 'gcp', this.projectId);
          zoneErrors.push(`${zone}: ${error.message}`);
          await this.report('warn', `${zone}: ${friendly.code === 'ZONE_EXHAUSTED' ? 'no spare GPUs right now' : 'this machine type isn\'t offered here'} — trying the next zone.`, error.message);
          continue;
        }
        // Quota, permission, credentials... would fail in every zone: stop now.
        throw error;
      }
    }

    // Every zone failed with a zone-specific problem.
    throw new Error(`ZONE_RESOURCE_POOL_EXHAUSTED in all zones of ${region.id}: ${zoneErrors.join(' | ')}`);
  }

  // ==========================================================================
  // The CloudProvider contract
  // ==========================================================================

  async launchInstance(
    config: ProviderConfig,
    options: LaunchOptions
  ): Promise<{ instanceId: string; ipAddress: string; costPerHour: number }> {
    return this.createMachine(config, {
      spot: !!options.spotInstance,
      diskSizeGb: options.diskSizeGb || 150,
      sunshineUsername: options.sunshineUsername || 'gamer',
      sunshinePassword: options.sunshinePassword || crypto.randomBytes(12).toString('base64url'),
      autoStopMinutes: options.autoStopMinutes,
    });
  }

  async stopInstance(instanceId: string): Promise<void> {
    const { zone, name } = this.splitId(instanceId);
    await this.report('info', `Asking Google to stop ${name} (compute billing stops; the disk is kept)…`);
    const [lro] = await this.instances.stop({ project: this.projectId, zone, instance: name });
    await this.waitZoneOp(lro, zone);
    await this.report('success', `${name} is stopped.`);
  }

  async startInstance(instanceId: string): Promise<void> {
    const { zone, name } = this.splitId(instanceId);
    await this.report('info', `Asking Google to start ${name}…`);
    const [lro] = await this.instances.start({ project: this.projectId, zone, instance: name });
    await this.waitZoneOp(lro, zone);
    await this.report('success', `${name} is running. (Its public IP may have changed — we'll read the new one.)`);
  }

  async terminateInstance(instanceId: string): Promise<void> {
    const { zone, name } = this.splitId(instanceId);
    await this.report('info', `Asking Google to delete ${name} and its disk…`);
    try {
      const [lro] = await this.instances.delete({ project: this.projectId, zone, instance: name });
      await this.waitZoneOp(lro, zone);
      await this.report('success', `${name} deleted — it no longer costs anything.`);
    } catch (error) {
      if (isNotFound(error)) {
        await this.report('warn', `${name} was already gone at Google Cloud (deleted elsewhere?). Cleaning up our record.`);
        return;
      }
      throw error;
    }
  }

  async getInstanceStatus(instanceId: string): Promise<{
    status: 'starting' | 'running' | 'stopping' | 'stopped' | 'terminated' | 'unknown';
    ipAddress?: string;
  }> {
    const { zone, name } = this.splitId(instanceId);
    try {
      const [instance] = await this.instances.get({ project: this.projectId, zone, instance: name });
      // Google's states -> ours.
      const map: Record<string, 'starting' | 'running' | 'stopping' | 'stopped'> = {
        PROVISIONING: 'starting',
        STAGING: 'starting',
        REPAIRING: 'starting',
        RUNNING: 'running',
        STOPPING: 'stopping',
        SUSPENDING: 'stopping',
        TERMINATED: 'stopped', // Google's word for "stopped" (not deleted!)
        STOPPED: 'stopped',
        SUSPENDED: 'stopped',
      };
      return { status: map[String(instance.status)] || 'unknown', ipAddress: this.natIp(instance) || undefined };
    } catch (error) {
      if (isNotFound(error)) return { status: 'terminated' };
      throw error;
    }
  }

  async createSnapshot(instanceId: string, _diskPath: string): Promise<{ snapshotId: string; sizeGb: number }> {
    // Our machines have one disk, named after the machine; we snapshot it whole.
    const { zone, name } = this.splitId(instanceId);
    const snapshotName = `${name}-${Date.now()}`;
    await this.report('info', `Snapshotting the disk of ${name} (games and settings included)…`);
    const [lro] = await this.disks.createSnapshot({
      project: this.projectId,
      zone,
      disk: name,
      snapshotResource: { name: snapshotName, labels: { app: 'cloudgaming-hub' } },
    });
    await this.waitZoneOp(lro, zone);
    const [disk] = await this.disks.get({ project: this.projectId, zone, disk: name });
    await this.report('success', `Snapshot ${snapshotName} created.`);
    return { snapshotId: snapshotName, sizeGb: Number(disk.sizeGb) || 0 };
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotInfo> {
    const [snap] = await this.snapshots.get({ project: this.projectId, snapshot: snapshotId });
    const status = String(snap.status);
    return {
      id: snapshotId,
      sizeGb: Number(snap.diskSizeGb) || 0,
      state: status === 'READY' ? 'completed' : status === 'FAILED' ? 'failed' : 'pending',
    };
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.report('info', `Deleting snapshot ${snapshotId}…`);
    try {
      const [lro] = await this.snapshots.delete({ project: this.projectId, snapshot: snapshotId });
      await this.waitGlobalOp(lro);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await this.report('success', `Snapshot ${snapshotId} deleted.`);
  }

  async restoreFromSnapshot(snapshotId: string, config: ProviderConfig): Promise<{ instanceId: string; ipAddress: string }> {
    await this.report('info', `Creating a new machine from snapshot ${snapshotId}…`);
    const { instanceId, ipAddress } = await this.createMachine(config, {
      spot: false,
      diskSizeGb: 150,
      sourceSnapshot: `global/snapshots/${snapshotId}`,
      sunshineUsername: 'gamer',
      sunshinePassword: crypto.randomBytes(12).toString('base64url'),
    });
    return { instanceId, ipAddress };
  }

  async replicateSnapshot(
    sourceSnapshotId: string,
    sourceProvider: string,
    _sourceRegion: string,
    _targetRegion: string
  ): Promise<{ snapshotId: string }> {
    // Google snapshots are GLOBAL: usable in any region of the project as-is.
    if (sourceProvider === 'gcp') return { snapshotId: sourceSnapshotId };
    throw new FriendlyCloudError({
      code: 'CROSS_CLOUD_UNSUPPORTED',
      title: 'Copying snapshots from another cloud into Google Cloud isn\'t supported yet',
      explanation: 'Each cloud stores disks in its own format; converting between them isn\'t built yet.',
      fixes: ['Launch a fresh machine on Google Cloud instead.'],
    });
  }

  async getRegions(): Promise<RegionData[]> {
    return GCP_REGIONS.map((r) => ({
      provider: 'gcp',
      name: r.name,
      region: r.id,
      lat: r.lat,
      lng: r.lng,
      onDemandPrice: estimateHourly('n1-standard-4+t4', r.id),
      spotPrice: estimateHourly('n1-standard-4+t4', r.id, true),
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

  async queryCosts(): Promise<{ computeCost: number; egressCost: number; storageCost: number }> {
    throw new FriendlyCloudError({
      code: 'GCP_COSTS_UNAVAILABLE',
      title: 'Actual Google Cloud spend isn\'t available yet',
      explanation:
        'Google only exposes real spend through a billing export to BigQuery, which isn\'t connected. Costs shown here are estimates from running time.',
      fixes: ['See exact spend in the Google Cloud console under Billing → Reports.'],
    });
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.projects.get({ project: this.projectId });
      return true;
    } catch (error) {
      console.error('[GCP] credential check failed:', (error as Error).message);
      return false;
    }
  }

  // ==========================================================================
  // Google-specific extras (used by the credential checks and machine pages)
  // ==========================================================================

  /** Project details, including GLOBAL quotas (e.g. GPUS_ALL_REGIONS). Throws on failure. */
  async getProject(): Promise<any> {
    const [project] = await this.projects.get({ project: this.projectId });
    return project;
  }

  /** A region's quotas (e.g. NVIDIA_T4_GPUS). */
  async getRegionQuotas(region: string = DEFAULT_REGION): Promise<Array<{ metric: string; limit: number; usage: number }>> {
    const [info] = await this.regions.get({ project: this.projectId, region });
    return (info.quotas || []).map((q: any) => ({ metric: String(q.metric), limit: Number(q.limit) || 0, usage: Number(q.usage) || 0 }));
  }

  /** Does our own network ("cloudgaming-net") exist yet? (Created on first launch.) */
  async hasOurNetwork(): Promise<boolean> {
    try {
      await this.networks.get({ project: this.projectId, network: NETWORK_NAME });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * Read the machine's serial console and extract the setup stages printed
   * by the startup script. Returns [] if nothing has been printed yet.
   */
  async getSetupProgress(instanceId: string): Promise<SetupStage[]> {
    const { zone, name } = this.splitId(instanceId);
    const [output] = await this.instances.getSerialPortOutput({ project: this.projectId, zone, instance: name, port: 1 });
    return parseSetupStages(output?.contents || '');
  }

  /** The Sunshine admin login stored in the machine's metadata, plus its IP. */
  async getConnectionInfo(instanceId: string): Promise<{ ipAddress: string; username?: string; password?: string; status: string }> {
    const { zone, name } = this.splitId(instanceId);
    const [instance] = await this.instances.get({ project: this.projectId, zone, instance: name });
    const items: Array<{ key: string; value: string }> = instance.metadata?.items || [];
    const get = (k: string) => items.find((i) => i.key === k)?.value;
    return {
      ipAddress: this.natIp(instance),
      username: get('sunshine-username'),
      password: get('sunshine-password'),
      status: String(instance.status),
    };
  }

  // ==========================================================================
  // Inventory (for the infrastructure map)
  // ==========================================================================

  /**
   * Everything CloudGaming Hub created in this project: machines, their
   * disks, snapshots, our network, subnets and firewall rules — found by our
   * label (app=cloudgaming-hub) or our "cg-" / "cloudgaming-" names.
   * Uses "aggregated list" calls, which return every zone in one request.
   */
  async listResources(): Promise<InventoryItem[]> {
    const items: InventoryItem[] = [];
    const project = this.projectId;
    const ours = (name?: string | null, labels?: Record<string, string> | null) =>
      (labels && labels.app === 'cloudgaming-hub') || (name || '').startsWith('cg-');
    const regionOf = (zone: string) => zone.slice(0, zone.lastIndexOf('-'));
    const lastPart = (url?: string | null) => (url || '').split('/').pop() || '';
    const consoleLink = (path: string) => `https://console.cloud.google.com/${path}?project=${project}`;

    // ---- Machines ------------------------------------------------------
    const vmIdByDiskLink = new Map<string, string>(); // disk selfLink -> our instanceId
    for await (const [, scoped] of this.instances.aggregatedListAsync({ project })) {
      for (const vm of (scoped as any).instances || []) {
        if (!ours(vm.name, vm.labels)) continue;
        const zone = lastPart(vm.zone);
        const instanceId = `${zone}/${vm.name}`;
        const machineType = lastPart(vm.machineType);
        const gpu = lastPart(vm.guestAccelerators?.[0]?.acceleratorType);
        const shapeId = machineType.startsWith('g2-') ? machineType : gpu.includes('t4') ? `${machineType}+t4` : machineType;
        const spot = String(vm.scheduling?.provisioningModel) === 'SPOT';
        for (const d of vm.disks || []) if (d.source) vmIdByDiskLink.set(d.source, instanceId);
        const raw = String(vm.status);
        items.push({
          provider: 'gcp', type: 'vm', id: instanceId, name: vm.name, region: regionOf(zone), zone,
          status: raw === 'TERMINATED' ? 'stopped' : raw.toLowerCase(),
          instanceId,
          hourlyCost: estimateHourly(shapeId, regionOf(zone), spot),
          consoleUrl: consoleLink(`compute/instancesDetail/zones/${zone}/instances/${vm.name}`),
          createdAt: vm.creationTimestamp || undefined,
        });
      }
    }

    // ---- Disks -----------------------------------------------------------
    const diskLinks = new Set<string>();
    for await (const [, scoped] of this.disks.aggregatedListAsync({ project })) {
      for (const d of (scoped as any).disks || []) {
        if (!ours(d.name, d.labels)) continue;
        diskLinks.add(d.selfLink);
        const zone = lastPart(d.zone);
        const users: string[] = d.users || [];
        const sizeGb = Number(d.sizeGb) || 0;
        items.push({
          provider: 'gcp', type: 'disk', id: `${zone}/${d.name}`, name: d.name, region: regionOf(zone), zone,
          status: users.length ? 'in-use' : 'available',
          attachedTo: users.length ? (vmIdByDiskLink.get(d.selfLink) || `${zone}/${lastPart(users[0])}`) : undefined,
          sizeGb,
          monthlyCost: Math.round(sizeGb * BALANCED_DISK_PER_GB_MONTH * 100) / 100,
          orphan: users.length === 0,
          orphanReason: users.length === 0 ? 'Disk not attached to any machine — still billed every month' : undefined,
          consoleUrl: consoleLink(`compute/disksDetail/zones/${zone}/disks/${d.name}`),
          createdAt: d.creationTimestamp || undefined,
        });
      }
    }

    // ---- Snapshots (global) ------------------------------------------------
    for await (const snap of this.snapshots.listAsync({ project })) {
      if (!ours(snap.name, snap.labels)) continue;
      const gb = Number(snap.storageBytes) ? Number(snap.storageBytes) / 1e9 : Number(snap.diskSizeGb) || 0;
      const sourceGone = !!snap.sourceDisk && !diskLinks.has(snap.sourceDisk);
      const zone = String(snap.sourceDisk || '').match(/zones\/([^/]+)/)?.[1];
      items.push({
        provider: 'gcp', type: 'snapshot', id: snap.name, name: snap.name,
        region: zone ? regionOf(zone) : 'global',
        status: String(snap.status).toLowerCase(),
        sizeGb: Math.round(gb * 10) / 10,
        monthlyCost: Math.round(gb * SNAPSHOT_PER_GB_MONTH * 100) / 100,
        orphan: sourceGone,
        orphanReason: sourceGone ? 'Backup of a machine that no longer exists — still billed every month' : undefined,
        consoleUrl: consoleLink(`compute/snapshotsDetail/projects/${project}/global/snapshots/${snap.name}`),
        createdAt: snap.creationTimestamp || undefined,
      });
    }

    // ---- Network, subnets, firewall rules ------------------------------------
    try {
      await this.networks.get({ project, network: NETWORK_NAME });
      items.push({ provider: 'gcp', type: 'network', id: NETWORK_NAME, name: NETWORK_NAME, region: 'global', status: 'active',
        consoleUrl: consoleLink(`networking/networks/details/${NETWORK_NAME}`) });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    for await (const [, scoped] of this.subnetworks.aggregatedListAsync({ project })) {
      for (const sn of (scoped as any).subnetworks || []) {
        if (!String(sn.name).startsWith('cloudgaming-')) continue;
        const region = lastPart(sn.region);
        items.push({ provider: 'gcp', type: 'subnet', id: `${region}/${sn.name}`, name: `${sn.name} (${sn.ipCidrRange})`, region, status: 'active',
          consoleUrl: consoleLink(`networking/subnetworks/details/${region}/${sn.name}`) });
      }
    }
    for await (const fw of this.firewalls.listAsync({ project })) {
      if (!String(fw.name).startsWith('cloudgaming-')) continue;
      items.push({ provider: 'gcp', type: 'firewall', id: fw.name, name: `${fw.name}${lastPart(fw.network) !== NETWORK_NAME ? ' (older version, on default network)' : ''}`,
        region: 'global', status: fw.disabled ? 'disabled' : 'active',
        consoleUrl: consoleLink(`net-security/firewall-manager/firewall-policies/details/${fw.name}`) });
    }

    return items;
  }

}
