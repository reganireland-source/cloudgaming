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
import { JWT } from 'google-auth-library';
import { CloudProvider, ProviderConfig, LaunchOptions, SnapshotInfo, RestoreOptions } from './Provider';
import { RegionData } from '../types';
import type { InventoryItem, BillingActuals, BillingDay, CloudInvoice, CloudInvoices } from './shared/types';
import { RESOURCE_TAG } from './shared/streaming';
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
  isG4,
  type GcpShape,
} from './gcp/catalog';

type GpuModel = GcpShape['gpuModel'];
import { buildSetupScript } from './shared/setupScript';

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

/** Google's licensed "virtual workstation" GPU types (GRID driver allowed), per our GPU model. */
const VWS_ACCELERATOR: Record<string, string> = { T4: 'nvidia-tesla-t4-vws', L4: 'nvidia-l4-vws', 'RTX PRO 6000': 'nvidia-rtx-pro-6000-vws' };

/** Live GPU zones per project (see getGpuZones). */
const GPU_FAMILY_CACHE = new Map<string, { at: number; value: Array<{ region: string; family: string; limit: number }> }>();
const GPU_ZONES_CACHE = new Map<string, { at: number; value: Record<string, Partial<Record<GpuModel, string[]>>> }>();

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
  private acceleratorTypes: any;
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

  private readonly privateKey: string;

  constructor(credentials: any) {
    super();
    const creds = GCPProvider.parseCredentials(credentials);
    this.projectId = creds.projectId;
    this.clientEmail = creds.clientEmail;
    this.privateKey = creds.privateKey;

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
    this.acceleratorTypes = new compute.AcceleratorTypesClient(opts);
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
          description: 'Gints Global Gaming Hubjob: network for gaming machines',
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
    const allowed = [
      { IPProtocol: 'tcp', ports: SUNSHINE_TCP_PORTS },
      { IPProtocol: 'udp', ports: SUNSHINE_UDP_PORTS },
    ];
    try {
      const [rule] = await this.firewalls.get({ project: this.projectId, firewall: FIREWALL_RULE_NAME });
      // Created before newer ports (e.g. browser access) were added? Update it.
      const has = (proto: string, port: string) => (rule.allowed || []).some((a: any) => a.IPProtocol === proto && (a.ports || []).includes(port));
      const missing = [...SUNSHINE_TCP_PORTS.filter((p) => !has('tcp', p)).map((p) => `TCP ${p}`), ...SUNSHINE_UDP_PORTS.filter((p) => !has('udp', p)).map((p) => `UDP ${p}`)];
      if (missing.length) {
        await this.report('info', `Adding ports to firewall rule "${FIREWALL_RULE_NAME}": ${missing.join(', ')}…`);
        const [lro] = await this.firewalls.patch({ project: this.projectId, firewall: FIREWALL_RULE_NAME, firewallResource: { allowed } });
        await this.waitGlobalOp(lro);
      }
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
        description: 'Gints Global Gaming Hubjob: Sunshine/Moonlight streaming ports',
        sourceRanges: ['0.0.0.0/0'],
        targetTags: [NETWORK_TAG],
        allowed,
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
               sunshineUsername: string; sunshinePassword: string; autoStopMinutes?: number;
               displayDriver?: 'standard' | 'grid'; nickname?: string }
  ): Promise<{ instanceId: string; ipAddress: string; costPerHour: number }> {
    const shape = findShape(config.instanceType);
    if (!shape) {
      throw new FriendlyCloudError({
        code: 'UNKNOWN_SHAPE',
        title: `Unknown machine type "${config.instanceType}"`,
        explanation: 'This machine type isn\'t one Gints Global Gaming Hubjob knows how to launch on Google Cloud.',
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

    if (options.displayDriver === 'grid' && !VWS_ACCELERATOR[shape.gpuModel]) {
      throw new FriendlyCloudError({
        code: 'NO_BIG_SCREEN',
        title: `Big screen isn't available on ${shape.gpuModel} machines`,
        explanation: `Google only licenses the GRID driver on its virtual workstation (vWS) GPUs, and offers no vWS version of the ${shape.gpuModel}.`,
        fixes: ['Launch it without big screen (2560×1600 is the most a headless screen can do on it), or pick an L4 machine for big screen.'],
      });
    }

    await this.report('info', `Project ${this.projectId} · ${shape.label} · ${region.name} (${region.id})` +
      `${options.spot ? ' · SPOT (cheaper, can be interrupted)' : ''}`);
    await this.ensureNetwork(region.id);
    await this.ensureFirewall();

    // A unique, Google-legal name: lowercase letters, digits, hyphens.
    const name = `cg-${crypto.randomBytes(4).toString('hex')}`;
    const zoneErrors: string[] = [];

    // Ask Google which zones of the region really sell this GPU (the catalog
    // is best knowledge); fall back to the catalog's zones if that fails.
    const live = await this.getGpuZones().catch(() => null);
    let letters = region.zones;
    if (live) {
      const zones = live[region.id]?.[shape.gpuModel] || [];
      if (!zones.length) {
        throw new FriendlyCloudError({
          code: 'GPU_NOT_IN_REGION',
          title: `${shape.gpuModel} GPUs aren't sold in ${region.name}`,
          explanation: `Google doesn't offer ${shape.gpuModel} GPUs in any zone of ${region.id} right now.`,
          fixes: [`Pick another region — the Regions page shows where each GPU is sold.`],
          consoleUrl: 'https://cloud.google.com/compute/docs/gpus/gpu-regions-zones', consoleLabel: 'Google\'s GPU regions list',
        });
      }
      const liveLetters = zones.map((z) => z.slice(region.id.length + 1));
      letters = [...region.zones.filter((l) => liveLetters.includes(l)), ...liveLetters.filter((l) => !region.zones.includes(l))];
    }

    for (const letter of letters) {
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
              // G4 (RTX PRO 6000) only takes Hyperdisk.
              diskType: `zones/${zone}/diskTypes/${isG4(shape.machineType) ? 'hyperdisk-balanced' : 'pd-balanced'}`,
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
            // G4 needs Google's gVNIC network card (Ubuntu 22.04 has the driver).
            ...(isG4(shape.machineType) ? { nicType: 'GVNIC' } : {}),
          },
        ],
        // GPU machines can't be live-migrated during Google maintenance, so
        // they must be allowed to stop ("TERMINATE") instead.
        scheduling: options.spot
          ? { onHostMaintenance: 'TERMINATE', automaticRestart: false, provisioningModel: 'SPOT', instanceTerminationAction: 'STOP' }
          : { onHostMaintenance: 'TERMINATE', automaticRestart: true, provisioningModel: 'STANDARD' },
        metadata: {
          items: [
            { key: 'startup-script', value: buildSetupScript({ sunshineUsername: options.sunshineUsername, sunshinePassword: options.sunshinePassword, autoStopMinutes: options.autoStopMinutes, displayDriver: options.displayDriver, gridSource: 'gcp', serverName: options.nickname }) },
            // Read by the machine at every boot (rename in the app = update this).
            ...(options.nickname ? [{ key: 'cg-nickname', value: options.nickname }] : []),
            { key: 'sunshine-username', value: options.sunshineUsername },
            { key: 'sunshine-password', value: options.sunshinePassword },
          ],
        },
      };
      if (options.displayDriver === 'grid') {
        // Big screen (experimental): Google licenses GRID only on its "vWS"
        // GPU types, billed extra per GPU-hour, with their own quota.
        resource.guestAccelerators = [
          { acceleratorCount: 1, acceleratorType: `zones/${zone}/acceleratorTypes/${VWS_ACCELERATOR[shape.gpuModel]}` },
        ];
      } else if (shape.gpuType) {
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
      displayDriver: options.displayDriver,
      nickname: options.nickname,
    });
  }

  async stopInstance(instanceId: string): Promise<void> {
    const { zone, name } = this.splitId(instanceId);
    await this.report('info', `Asking Google to stop ${name} (compute billing stops; the disk is kept)…`);
    const [lro] = await this.instances.stop({ project: this.projectId, zone, instance: name });
    await this.waitZoneOp(lro, zone);
    await this.report('success', `${name} is stopped.`);
  }

  readonly canSwitchSpotInPlace = true;

  /** Instance metadata "cg-nickname" (setMetadata needs the current fingerprint). */
  async setNickname(instanceId: string, nickname: string): Promise<boolean> {
    const { zone, name } = this.splitId(instanceId);
    const [inst] = await this.instances.get({ project: this.projectId, zone, instance: name });
    const items = (inst.metadata?.items || []).filter((i: any) => i.key !== 'cg-nickname');
    items.push({ key: 'cg-nickname', value: nickname });
    const [lro] = await this.instances.setMetadata({ project: this.projectId, zone, instance: name, metadataResource: { fingerprint: inst.metadata?.fingerprint, items } } as any);
    await this.waitZoneOp(lro, zone);
    return true;
  }

  /**
   * Spot <-> on-demand on a stopped VM (Google allows changing the
   * provisioning model while TERMINATED). Same scheduling as at launch.
   */
  async setSpot(instanceId: string, spot: boolean): Promise<void> {
    const { zone, name } = this.splitId(instanceId);
    await this.report('info', `Switching ${name} to ${spot ? 'spot (cheaper; Google can reclaim it)' : 'on-demand (full price; never reclaimed)'}…`);
    const [lro] = await this.instances.setScheduling({
      project: this.projectId, zone, instance: name,
      schedulingResource: spot
        // Spot VMs are recorded as preemptible: true + provisioningModel SPOT. It must be set
        // explicitly: a machine that was on-demand keeps preemptible: false otherwise, and
        // Google rejects "preemptible=false and provisioning_model=SPOT is contradicting".
        ? { onHostMaintenance: 'TERMINATE', automaticRestart: false, provisioningModel: 'SPOT', instanceTerminationAction: 'STOP', preemptible: true }
        : { onHostMaintenance: 'TERMINATE', automaticRestart: true, provisioningModel: 'STANDARD', preemptible: false },
    } as any);
    await this.waitZoneOp(lro, zone);
    await this.report('success', `${name} is now ${spot ? 'spot' : 'on-demand'}.`);
  }

  async rebootInstance(instanceId: string): Promise<void> {
    const { zone, name } = this.splitId(instanceId);
    await this.report('info', `Asking Google to restart ${name} (a hard reset: same machine, same disk and IP)…`);
    const [lro] = await this.instances.reset({ project: this.projectId, zone, instance: name });
    await this.waitZoneOp(lro, zone);
    await this.report('success', `${name} restarted.`);
  }

  /** Google logs a zone operation when it reclaims a spot machine or the machine powers itself off. */
  async getStopReason(instanceId: string): Promise<string | null> {
    const { zone, name } = this.splitId(instanceId);
    const since = Date.now() - 48 * 3600_000;
    // Filter on the machine only (a simple, well-supported filter) and pick
    // the stop-type operations here.
    const [ops] = await this.zoneOps.list({
      project: this.projectId, zone, maxResults: 500,
      filter: `targetLink eq ".*/instances/${name}"`,
    }) as any;
    const kinds = ['compute.instances.preempted', 'compute.instances.guestTerminate', 'compute.instances.hostError', 'compute.instances.stop'];
    const mine = (ops || [])
      .filter((o: any) => kinds.includes(o.operationType) && String(o.targetLink || '').endsWith(`/instances/${name}`) && Date.parse(o.insertTime || '') > since)
      .sort((a: any, b: any) => Date.parse(b.insertTime) - Date.parse(a.insertTime))[0];
    if (!mine) return null;
    const at = new Date(mine.insertTime).toISOString().slice(11, 16) + ' UTC';
    switch (mine.operationType) {
      case 'compute.instances.preempted': return `Google reclaimed this spot machine at ${at} (spot machines can be taken back at any time). Your disk and progress are kept.`;
      case 'compute.instances.guestTerminate': return `The machine shut itself down at ${at} (auto-stop, or a shutdown from inside it).`;
      case 'compute.instances.stop': return `It was stopped at ${at} with a Stop request (this app, the Google console or gcloud).`;
      default: return `Google stopped the machine at ${at} because of a problem with the physical host.`;
    }
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

  /**
   * Actual charges from Google's Cloud Billing export to BigQuery - the only
   * place Google provides billed costs by API. `exportTable` is the table the
   * export writes, e.g. "my-project.billing.gcp_billing_export_v1_0123AB_...".
   * Cost includes credits (free-trial, sustained-use discounts), in the
   * billing account's currency. "This app" = resources labelled
   * app=cloudgaming-hub in this project.
   * The key needs BigQuery Job User (to run the query) in this project and
   * BigQuery Data Viewer on the export dataset.
   */
  /**
   * Find the billing export table in this project ("…gcp_billing_export_v1_…"),
   * so it doesn't have to be pasted. Needs BigQuery read access (Data Viewer).
   */
  async findBillingExportTable(): Promise<string | null> {
    try {
      const { JWT } = await import('google-auth-library');
      const client = new JWT({ email: this.clientEmail, key: this.privateKey, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
      const ds: any = (await client.request({ url: `https://bigquery.googleapis.com/bigquery/v2/projects/${this.projectId}/datasets?maxResults=200` })).data;
      for (const d of ds?.datasets || []) {
        const id = d.datasetReference?.datasetId;
        const t: any = (await client.request({ url: `https://bigquery.googleapis.com/bigquery/v2/projects/${this.projectId}/datasets/${id}/tables?maxResults=500` })).data;
        const hit = (t?.tables || []).map((x: any) => x.tableReference?.tableId).find((n: string) => /^gcp_billing_export_v1_/.test(n || ''));
        if (hit) return `${this.projectId}.${id}.${hit}`;
      }
    } catch { /* no access or no BigQuery: fall back to the saved name */ }
    return null;
  }

  /**
   * Google has no invoice API. The billing export tags every row with the
   * invoice it lands on (invoice.month), so this gives per-invoice totals
   * for this project; due dates aren't available.
   */
  async getInvoices(settings: { exportTable?: string } = {}): Promise<CloudInvoices> {
    const table = String(settings.exportTable || '').trim().replace(/`/g, '') || await this.findBillingExportTable();
    if (!table) {
      throw new FriendlyCloudError({ code: 'BILLING_SETUP', title: 'Google Cloud billing export isn\'t set up yet', explanation: 'Google gives invoice totals only through the billing export to BigQuery.', fixes: ['Follow Billing access → Google Cloud on the Costs page.'], consoleUrl: 'https://console.cloud.google.com/billing/export', consoleLabel: 'Open Billing export' });
    }
    const { JWT } = await import('google-auth-library');
    const client = new JWT({ email: this.clientEmail, key: this.privateKey, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const sql = `SELECT invoice.month AS month, currency, SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS total
      FROM \`${table}\` WHERE project.id = @project AND invoice.month IS NOT NULL
      GROUP BY month, currency ORDER BY month DESC LIMIT 7`;
    const res: any = (await client.request({
      url: `https://bigquery.googleapis.com/bigquery/v2/projects/${this.projectId}/queries`, method: 'POST',
      data: { query: sql, useLegacySql: false, parameterMode: 'NAMED', timeoutMs: 30000, queryParameters: [{ name: 'project', parameterType: { type: 'STRING' }, parameterValue: { value: this.projectId } }] },
    })).data;
    const thisMonth = new Date().toISOString().slice(0, 7).replace('-', '');
    const invoices: CloudInvoice[] = (res?.rows || []).map((r: any) => {
      const [m, cur, total] = r.f.map((x: any) => x.v);
      return { id: `invoice month ${m}`, period: `${String(m).slice(0, 4)}-${String(m).slice(4)}`, amount: Math.round(Number(total) * 100) / 100, currency: String(cur), status: m === thisMonth ? 'In progress (this month)' : 'Billed' };
    });
    return {
      invoices,
      notes: ['Google has no invoice API: these are this project\'s totals per invoice month from your billing export, without due dates. Self-serve accounts are charged automatically at the start of each month (or when a threshold is reached); invoiced accounts follow their payment terms.'],
      consoleUrl: 'https://console.cloud.google.com/billing/payment', consoleLabel: 'Open Payments & invoices',
    };
  }

  async getBillingActuals(from: string, to: string, settings: { exportTable?: string } = {}): Promise<BillingActuals> {
    const table = String(settings.exportTable || '').trim().replace(/`/g, '') || await this.findBillingExportTable() || '';
    if (!table) {
      throw new FriendlyCloudError({
        code: 'BILLING_SETUP', title: 'Google Cloud billing export isn\'t set up yet',
        explanation: 'Google only provides actual (billed) costs through its billing export to BigQuery. It\'s a one-time setting, and data starts from the day you turn it on.',
        fixes: [
          'Billing → Billing export → BigQuery export → Standard usage cost → Edit settings: pick this project and create a dataset (e.g. "billing"). Save.',
          `Give the app's service account (${this.clientEmail}) the roles "BigQuery Job User" on this project and "BigQuery Data Viewer" on that dataset.`,
          'After a few hours BigQuery shows a table named gcp_billing_export_v1_…: the app finds it by itself (Bills & billing access → Google Cloud has the commands for the dataset and permissions).',
        ],
        consoleUrl: 'https://console.cloud.google.com/billing/export', consoleLabel: 'Open Billing export',
      });
    }
    if (!/^[A-Za-z0-9_.:-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(table)) {
      throw new FriendlyCloudError({
        code: 'BILLING_SETUP', title: 'That doesn\'t look like a BigQuery table name',
        explanation: `Expected "project.dataset.table", got "${table}".`,
        fixes: ['In BigQuery, open the export table → Details → copy "Table ID".'],
      });
    }
    const { JWT } = await import('google-auth-library');
    const client = new JWT({ email: this.clientEmail, key: this.privateKey, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const credits = 'IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)';
    const isApp = `EXISTS(SELECT 1 FROM UNNEST(labels) l WHERE l.key = '${RESOURCE_TAG.key}' AND l.value = '${RESOURCE_TAG.value}')`;
    const sql = `SELECT FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time)) AS day, currency,
        SUM(cost) + SUM(${credits}) AS account_total,
        SUM(IF(${isApp}, cost + ${credits}, 0)) AS app_total
      FROM \`${table}\`
      WHERE usage_start_time >= TIMESTAMP(@from) AND usage_start_time < TIMESTAMP(@to) AND project.id = @project
      GROUP BY day, currency ORDER BY day`;
    let res: any;
    try {
      res = (await client.request({
        url: `https://bigquery.googleapis.com/bigquery/v2/projects/${this.projectId}/queries`, method: 'POST',
        data: {
          query: sql, useLegacySql: false, parameterMode: 'NAMED', timeoutMs: 30000,
          queryParameters: [
            { name: 'from', parameterType: { type: 'STRING' }, parameterValue: { value: from } },
            { name: 'to', parameterType: { type: 'STRING' }, parameterValue: { value: to } },
            { name: 'project', parameterType: { type: 'STRING' }, parameterValue: { value: this.projectId } },
          ],
        },
      })).data;
      for (let i = 0; res && res.jobComplete === false && i < 10; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const loc = res.jobReference?.location ? `?location=${encodeURIComponent(res.jobReference.location)}` : '';
        res = (await client.request({ url: `https://bigquery.googleapis.com/bigquery/v2/projects/${this.projectId}/queries/${res.jobReference.jobId}${loc}` })).data;
      }
    } catch (error: any) {
      const status = error?.response?.status;
      const msg = String(error?.response?.data?.error?.message || error?.message || error);
      if (status === 403 || /denied|permission/i.test(msg)) {
        throw new FriendlyCloudError({
          code: 'BILLING_PERMISSION', title: 'The service account can\'t read the billing export',
          explanation: `Google answered: ${msg}`,
          fixes: [`Grant ${this.clientEmail} "BigQuery Job User" on project ${this.projectId}, and "BigQuery Data Viewer" on the export's dataset.`,
            `gcloud projects add-iam-policy-binding ${this.projectId} --member=serviceAccount:${this.clientEmail} --role=roles/bigquery.jobUser`],
          consoleUrl: `https://console.cloud.google.com/iam-admin/iam?project=${this.projectId}`, consoleLabel: 'Open IAM',
        });
      }
      if (status === 404 || /not found/i.test(msg)) {
        throw new FriendlyCloudError({
          code: 'BILLING_SETUP', title: 'Billing export table not found',
          explanation: `Google answered: ${msg}`,
          fixes: ['Check the table name on the Costs page ("project.dataset.table"). A new export takes a few hours to create its table.'],
          consoleUrl: 'https://console.cloud.google.com/bigquery', consoleLabel: 'Open BigQuery',
        });
      }
      throw error;
    }
    const app: BillingDay[] = [];
    const account: BillingDay[] = [];
    let currency = 'USD';
    for (const row of res?.rows || []) {
      const [day, cur, accountTotal, appTotal] = row.f.map((c: any) => c.v);
      if (cur) currency = String(cur);
      account.push({ date: String(day), amount: Number(accountTotal) || 0 });
      app.push({ date: String(day), amount: Number(appTotal) || 0 });
    }
    return {
      currency, scope: 'app', scopeNote: `Resources labelled ${RESOURCE_TAG.key}=${RESOURCE_TAG.value} in ${this.projectId} (credits included)`,
      daily: app, accountDaily: account,
      notes: ['Google\'s export runs a few hours behind, and has no data from before it was switched on.'],
    };
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
      storedGb: Number(snap.storageBytes) ? Math.round(Number(snap.storageBytes) / 1e8) / 10 : undefined,
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

  async restoreFromSnapshot(snapshotId: string, config: ProviderConfig, opts: RestoreOptions = {}): Promise<{ instanceId: string; ipAddress: string }> {
    await this.report('info', `Creating a new machine from snapshot ${snapshotId}…`);
    // Google snapshots are global, so this works in any region of the project.
    const { instanceId, ipAddress } = await this.createMachine(config, {
      spot: !!opts.spot,
      diskSizeGb: opts.diskSizeGb || 150,
      sourceSnapshot: `global/snapshots/${snapshotId}`,
      sunshineUsername: opts.sunshineUsername || 'gamer',
      sunshinePassword: opts.sunshinePassword || crypto.randomBytes(12).toString('base64url'),
      autoStopMinutes: opts.autoStopMinutes,
      displayDriver: opts.displayDriver,
      nickname: opts.nickname,
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

  /**
   * Where Google sells our GPUs: { region: { T4: [zones], L4: [zones] } },
   * from the live accelerator list (one call for every zone). Cached for 6 h
   * per project.
   */
  async getGpuZones(): Promise<Record<string, Partial<Record<GpuModel, string[]>>>> {
    const hit = GPU_ZONES_CACHE.get(this.projectId);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.value;
    const byName: Record<string, GpuModel> = { 'nvidia-tesla-t4': 'T4', 'nvidia-l4': 'L4', 'nvidia-rtx-pro-6000': 'RTX PRO 6000' };
    const value: Record<string, Partial<Record<GpuModel, string[]>>> = {};
    for await (const [scope, list] of this.acceleratorTypes.aggregatedListAsync({ project: this.projectId })) {
      const zone = String(scope).replace(/^zones\//, '');
      for (const a of (list as any)?.acceleratorTypes || []) {
        const model = byName[String(a.name)];
        if (!model) continue;
        const region = zone.replace(/-[a-z]$/, '');
        ((value[region] ||= {})[model] ||= []).push(zone);
      }
    }
    for (const r of Object.values(value)) for (const z of Object.values(r)) z!.sort();
    GPU_ZONES_CACHE.set(this.projectId, { at: Date.now(), value });
    return value;
  }

  /** A region's quotas (e.g. NVIDIA_T4_GPUS). */
  /**
   * Every compute quota request ("quota preference" in the Cloud Quotas API,
   * which the console's quota page also writes), whatever its state. The
   * caller decides what is still pending by comparing with the current limit:
   * a request under review often has no grantedValue and isn't "reconciling",
   * so neither flag alone is enough. Keyed like compute metrics
   * (NVIDIA_L4_GPUS, PREEMPTIBLE_NVIDIA_T4_GPUS, GPU_FAMILY:NVIDIA_RTX_PRO_6000).
   * id = the preference's id (for "gcloud beta quotas preferences update").
   * null = can't read (API off or no permission). Region "" = global.
   */
  async getQuotaRequests(): Promise<Array<{ id: string; quotaId: string; metric: string; region: string; requested: number; granted: number | null; reconciling: boolean; status: string; created?: string; updated?: string }> | null> {
    try {
      const jwt = new JWT({ email: this.clientEmail, key: this.privateKey, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
      const out: Array<{ id: string; quotaId: string; metric: string; region: string; requested: number; granted: number | null; reconciling: boolean; status: string; created?: string; updated?: string }> = [];
      let pageToken = '';
      for (let page = 0; page < 5; page++) {
        const url = `https://cloudquotas.googleapis.com/v1/projects/${this.projectId}/locations/global/quotaPreferences?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const res: any = await jwt.request({ url });
        for (const p of res.data?.quotaPreferences || []) {
          if (p.service !== 'compute.googleapis.com') continue;
          const requested = Number(p.quotaConfig?.preferredValue);
          if (!Number.isFinite(requested)) continue;
          const granted = p.quotaConfig?.grantedValue != null ? Number(p.quotaConfig.grantedValue) : null;
          out.push({
            id: String(p.name || '').split('/').pop() || '',
            quotaId: String(p.quotaId || ''),
            metric: p.dimensions?.gpu_family ? `GPU_FAMILY:${p.dimensions.gpu_family}` // GPUS-PER-GPU-FAMILY (G4)
              : String(p.quotaId || '').replace(/-per-.*$/, '').replace(/-/g, '_').toUpperCase(),
            region: String(p.dimensions?.region || ''),
            requested, granted, reconciling: p.reconciling === true,
            status: p.reconciling ? 'being processed'
              : p.quotaConfig?.stateDetail || (granted != null && granted > 0 ? `${granted} granted so far` : 'waiting for Google'),
            created: p.createTime, updated: p.updateTime,
          });
        }
        pageToken = res.data?.nextPageToken || '';
        if (!pageToken) break;
      }
      return out;
    } catch {
      return null;
    }
  }

  async getRegionQuotas(region: string = DEFAULT_REGION): Promise<Array<{ metric: string; limit: number; usage: number }>> {
    const [info] = await this.regions.get({ project: this.projectId, region });
    const out = (info.quotas || []).map((q: any) => ({ metric: String(q.metric), limit: Number(q.limit) || 0, usage: Number(q.usage) || 0 }));
    // Newer GPUs (G4's RTX PRO 6000) use the per-family quota
    // GPUS-PER-GPU-FAMILY; if the region list doesn't carry it, read the
    // limits from the Cloud Quotas API (usage unknown there → 0).
    if (!out.some((q: { metric: string }) => q.metric.startsWith('GPU_FAMILY:'))) {
      for (const f of (await this.getGpuFamilyLimits().catch(() => [])).filter((x) => x.region === region)) {
        out.push({ metric: `GPU_FAMILY:${f.family}`, limit: f.limit, usage: 0 });
      }
    }
    return out;
  }

  /** GPUS-PER-GPU-FAMILY limits per region and family (Cloud Quotas API). Cached 10 min. */
  private async getGpuFamilyLimits(): Promise<Array<{ region: string; family: string; limit: number }>> {
    const hit = GPU_FAMILY_CACHE.get(this.projectId);
    if (hit && Date.now() - hit.at < 600_000) return hit.value;
    const jwt = new JWT({ email: this.clientEmail, key: this.privateKey, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const res: any = await jwt.request({ url: `https://cloudquotas.googleapis.com/v1/projects/${this.projectId}/locations/global/services/compute.googleapis.com/quotaInfos/GPUS-PER-GPU-FAMILY-per-project-region` });
    const value = (res.data?.dimensionsInfos || [])
      .filter((d: any) => d.dimensions?.region && d.dimensions?.gpu_family)
      .map((d: any) => ({ region: String(d.dimensions.region), family: String(d.dimensions.gpu_family), limit: Number(d.details?.value) || 0 }));
    GPU_FAMILY_CACHE.set(this.projectId, { at: Date.now(), value });
    return value;
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
  async getConsoleText(instanceId: string): Promise<string> {
    const { zone, name } = this.splitId(instanceId);
    const [output] = await this.instances.getSerialPortOutput({ project: this.projectId, zone, instance: name, port: 1 });
    return output?.contents || '';
  }

  readonly diskResizeWhileRunning = true;

  /** Persistent disks / Hyperdisk grow online; the machine grows its filesystem itself. */
  async resizeDisk(instanceId: string, sizeGb: number): Promise<void> {
    const { zone, name } = this.splitId(instanceId);
    const [instance] = await this.instances.get({ project: this.projectId, zone, instance: name });
    const boot = (instance.disks || []).find((d: any) => d.boot) || instance.disks?.[0];
    const disk = String(boot?.source || '').split('/').pop();
    if (!disk) throw new Error(`Couldn't find the disk of ${name}.`);
    await this.report('info', `Enlarging disk ${disk} to ${sizeGb} GB (Google does this while the machine runs)…`);
    const [lro] = await this.disks.resize({ project: this.projectId, zone, disk, disksResizeRequestResource: { sizeGb: String(sizeGb) } });
    await this.waitZoneOp(lro, zone);
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
   * Everything Gints Global Gaming Hubjob created in this project: machines, their
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
        const shapeId = machineType.startsWith('g2-') || isG4(machineType) ? machineType : gpu.includes('t4') ? `${machineType}+t4` : machineType;
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
