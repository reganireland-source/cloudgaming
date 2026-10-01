/**
 * ============================================================================
 * src/providers/OracleProvider.ts — ORACLE CLOUD INFRASTRUCTURE (OCI)
 * ============================================================================
 *
 * The Oracle version of the CloudProvider contract (Provider.ts). It creates,
 * starts, stops, deletes and backs up GPU virtual machines in the USER'S OWN
 * Oracle Cloud account, using the API key they added on the Config page
 * (stored encrypted — see CredentialService.ts).
 *
 * KEY IDEAS (Oracle's vocabulary)
 * -------------------------------
 * - OCID: every Oracle object has a long id like
 *   "ocid1.instance.oc1.ap-singapore-1.anqwgljr...". We pass these around.
 * - TENANCY: your whole Oracle account. COMPARTMENT: a folder inside it that
 *   holds resources and has its own permissions. We use the compartment the
 *   user chose, or the tenancy's root compartment by default.
 * - SHAPE: a machine size, e.g. "VM.GPU.A10.1" (see oracle/catalog.ts).
 * - AVAILABILITY DOMAIN (AD): a data centre inside a region (like a GCP
 *   zone). GPU capacity and GPU service limits are per AD, so launching tries
 *   each AD of the region until one works.
 * - VCN: "virtual cloud network" — your private network in a region. Oracle
 *   has NO default network, so we create one ("cloudgaming-vcn") with an
 *   internet gateway, a route to the internet, a SECURITY LIST (Oracle's
 *   firewall) opening the streaming ports, and a public subnet.
 * - BOOT VOLUME BACKUP: Oracle's word for a disk snapshot. We use them for
 *   createSnapshot/restoreFromSnapshot, and can copy them to other regions.
 * - PREEMPTIBLE: Oracle's "spot" — ~50% off, may be reclaimed at any time,
 *   and (unlike AWS/GCP) can't be stopped, only deleted.
 *
 * OUR IDs
 * -------
 *   instance id  "<region>/<instance OCID>"          e.g. "ap-singapore-1/ocid1.instance.oc1...."
 *   snapshot id  "<region>/<boot volume backup OCID>"
 * Every later call needs to know the region too (each region has its own
 * API address), so we keep it in the id.
 *
 * NO SSH: the machine configures itself with a first-boot script
 * (shared/setupScript.ts) passed as cloud-init "user_data". We watch its
 * progress through Oracle's "console history" (a capture of the serial
 * console). Every step calls this.report(...), which (when a reporter is
 * attached) writes a line into the operation log the frontend shows live.
 *
 * CREDENTIALS SHAPE (what the Config page saves, encrypted)
 * ---------------------------------------------------------
 *   { tenancyOcid, userOcid, fingerprint, privateKey, passphrase?, region, compartmentOcid? }
 * ============================================================================
 */

import crypto from 'crypto';
import * as common from 'oci-common';
import * as core from 'oci-core';
import * as identity from 'oci-identity';
import * as limits from 'oci-limits';
import * as usageapi from 'oci-usageapi';
import * as ospgateway from 'oci-ospgateway';
import { CloudProvider, ProviderConfig, LaunchOptions, SnapshotInfo, RestoreOptions } from './Provider';
import { RegionData } from '../types';
// Shared errors FIRST: it registers the Oracle rules from oracle/errors.
import { FriendlyCloudError, toFriendlyError } from './errors';
import { isOracleAdSpecificError, isOracleCapacityError } from './oracle/errors';
import {
  BACKUP_PER_GB_MONTH,
  BOOT_VOLUME_PER_GB_MONTH,
  DEFAULT_REGION,
  DEFAULT_SHAPE,
  IGW_NAME,
  IMAGE_OS,
  IMAGE_OS_VERSION,
  ORACLE_REGIONS,
  ORACLE_SHAPES,
  SUBNET_CIDR,
  SUBNET_NAME,
  VCN_CIDR,
  VCN_NAME,
  estimateHourly,
  findRegion,
  findShape,
} from './oracle/catalog';
import { RESOURCE_TAG, STREAMING_FIREWALL_NAME, SUNSHINE_PORT_RANGES } from './shared/streaming';
import zlib from 'zlib';
import { buildSetupScript, parseSetupStages, SetupStage } from './shared/setupScript';
import type { InventoryItem, BillingActuals, BillingDay, CloudInvoice, CloudInvoices } from './shared/types';

/** The parsed, checked credentials. */
export interface OracleCredentials {
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  privateKey: string;
  passphrase?: string;
  region: string;           // the "home"/default region, e.g. 'ap-singapore-1'
  compartmentOcid: string;  // where machines are created (defaults to the tenancy = root compartment)
}

type Status = 'starting' | 'running' | 'stopping' | 'stopped' | 'terminated' | 'unknown';

/** The four Oracle API clients we need, all pointed at ONE region. */
interface RegionClients {
  compute: core.ComputeClient;
  network: core.VirtualNetworkClient;
  storage: core.BlockstorageClient;
  identity: identity.IdentityClient;
}

// ---------------------------------------------------------------------------
// Small helpers (exported ones are also used by oracle/checks.ts)
// ---------------------------------------------------------------------------

/** OCIDs always look like "ocid1.<type>.<realm>.<region or empty>.<unique part>". */
export const OCID_RE = {
  tenancy: /^ocid1\.tenancy\.[a-z0-9-]+\.[a-z0-9-]*\.[a-z0-9]+$/,
  user: /^ocid1\.user\.[a-z0-9-]+\.[a-z0-9-]*\.[a-z0-9]+$/,
  compartment: /^ocid1\.(compartment|tenancy)\.[a-z0-9-]+\.[a-z0-9-]*\.[a-z0-9]+$/,
};
/** An API key fingerprint: 16 pairs of hex digits separated by colons. */
export const FINGERPRINT_RE = /^([0-9a-f]{2}:){15}[0-9a-f]{2}$/;
/** Region ids look like "ap-singapore-1", "us-ashburn-1", "sa-saopaulo-1". */
export const REGION_RE = /^[a-z]{2,}-[a-z]+-\d+$/;

/**
 * Tidy a pasted private key: fix Windows line endings and "\n" typed as text,
 * and cut away anything outside the BEGIN/END lines. (Keys downloaded from
 * the Oracle console end with an extra "OCI_API_KEY" line after END, which
 * some tools choke on.) Returns '' if no PEM block is found.
 */
export function cleanPrivateKey(text: string): string {
  const normalised = String(text || '').replace(/\\n/g, '\n').replace(/\r\n?/g, '\n').trim();
  const match = normalised.match(/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/);
  return match ? match[0] + '\n' : '';
}

/**
 * The fingerprint Oracle shows for an API key: the MD5 hash of the PUBLIC
 * key (in DER form), written as aa:bb:cc:... We can compute it from the
 * private key, which lets us spot "fingerprint and key don't match" before
 * even asking Oracle. Throws if the key can't be read.
 */
export function fingerprintOfPrivateKey(privateKey: string, passphrase?: string): string {
  const key = crypto.createPrivateKey({ key: privateKey, format: 'pem', passphrase: passphrase || undefined });
  const der = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const hex = crypto.createHash('md5').update(der).digest('hex');
  return hex.match(/../g)!.join(':');
}

/** Is this Oracle saying "doesn't exist (or you can't see it)"? */
function isNotFound(error: any): boolean {
  return error?.statusCode === 404 || /NotAuthorizedOrNotFound|NotFound/.test(String(error?.serviceCode));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const freeformTags = () => ({ [RESOURCE_TAG.key]: RESOURCE_TAG.value });
// Oracle's SDK retries some failures by itself (up to 8 times, with pauses).
// 3 tries is plenty for us and keeps error messages quick.
const CLIENT_CONFIG: common.ClientConfiguration = {
  retryConfiguration: { terminationStrategy: new common.MaxAttemptsTerminationStrategy(3) },
};

export class OracleProvider extends CloudProvider {
  name = 'oracle' as const;
  readonly selfConfiguring = true;

  readonly tenancyOcid: string;
  readonly userOcid: string;
  readonly compartmentId: string;
  readonly homeRegion: string;

  private readonly auth: common.SimpleAuthenticationDetailsProvider;
  private readonly clientsByRegion = new Map<string, RegionClients>();

  /**
   * Turn whatever was stored (or typed on the Config page) into checked
   * credentials, or throw a friendly error explaining exactly what's wrong.
   */
  static parseCredentials(raw: any): OracleCredentials {
    const text = (v: unknown) => String(v ?? '').trim();
    const tenancyOcid = text(raw?.tenancyOcid);
    const userOcid = text(raw?.userOcid);
    const fingerprint = text(raw?.fingerprint).toLowerCase();
    const region = text(raw?.region).toLowerCase() || DEFAULT_REGION;
    const compartmentOcid = text(raw?.compartmentOcid) || tenancyOcid;
    const passphrase = text(raw?.passphrase) || undefined;
    const privateKey = cleanPrivateKey(raw?.privateKey);

    const where = 'In the Oracle console: Profile (top right) → My profile → API keys. The "Configuration file preview" of your key lists tenancy, user, fingerprint and region.';
    if (!OCID_RE.tenancy.test(tenancyOcid)) {
      throw new FriendlyCloudError({
        code: 'OCI_BAD_TENANCY',
        title: 'The Tenancy OCID doesn\'t look right',
        explanation: 'A tenancy OCID starts with "ocid1.tenancy.oc1.." followed by a long string of letters and digits.',
        fixes: [where, 'Copy the "tenancy=" value (without "tenancy=").'],
      });
    }
    if (!OCID_RE.user.test(userOcid)) {
      throw new FriendlyCloudError({
        code: 'OCI_BAD_USER',
        title: 'The User OCID doesn\'t look right',
        explanation: 'A user OCID starts with "ocid1.user.oc1.." — make sure it isn\'t the tenancy or a group OCID.',
        fixes: [where, 'Copy the "user=" value.'],
      });
    }
    if (!FINGERPRINT_RE.test(fingerprint)) {
      throw new FriendlyCloudError({
        code: 'OCI_BAD_FINGERPRINT',
        title: 'The fingerprint doesn\'t look right',
        explanation: 'An API key fingerprint is 16 pairs of hex digits separated by colons, e.g. 12:34:56:78:9a:bc:de:f0:12:34:56:78:9a:bc:de:f0.',
        fixes: [where, 'Copy the "fingerprint=" value.'],
      });
    }
    if (!REGION_RE.test(region)) {
      throw new FriendlyCloudError({
        code: 'OCI_BAD_REGION',
        title: `"${region}" isn't an Oracle region id`,
        explanation: 'Oracle region ids look like ap-singapore-1, us-ashburn-1 or eu-frankfurt-1 (not the display name "Singapore").',
        fixes: [where, 'Copy the "region=" value.'],
      });
    }
    if (!OCID_RE.compartment.test(compartmentOcid)) {
      throw new FriendlyCloudError({
        code: 'OCI_BAD_COMPARTMENT',
        title: 'The Compartment OCID doesn\'t look right',
        explanation: 'A compartment OCID starts with "ocid1.compartment.oc1..". Leave the field empty to use your tenancy\'s root compartment.',
        fixes: ['Identity & Security → Compartments → click the compartment → copy its OCID.'],
      });
    }
    if (!privateKey) {
      throw new FriendlyCloudError({
        code: 'OCI_NO_PRIVATE_KEY',
        title: 'No private key found',
        explanation: 'We need the PRIVATE key (.pem file) of your API key. It starts with "-----BEGIN PRIVATE KEY-----".',
        fixes: ['Upload the private key file you downloaded when you added the API key (not the "_public.pem" one).'],
      });
    }
    if (/BEGIN PUBLIC KEY/.test(privateKey)) {
      throw new FriendlyCloudError({
        code: 'OCI_PUBLIC_KEY_GIVEN',
        title: 'That\'s the PUBLIC key — we need the PRIVATE one',
        explanation: 'Oracle only stores your public key. The private key is the other file you downloaded when adding the API key.',
        fixes: [
          'Use the file whose name does NOT end in "_public.pem" — it starts with "-----BEGIN PRIVATE KEY-----".',
          'If you no longer have it, add a new API key (Profile → My profile → API keys → Add API key → Download private key).',
        ],
      });
    }
    return { tenancyOcid, userOcid, fingerprint, privateKey, passphrase, region, compartmentOcid };
  }

  constructor(credentials: any) {
    super();
    const creds = OracleProvider.parseCredentials(credentials);
    this.tenancyOcid = creds.tenancyOcid;
    this.userOcid = creds.userOcid;
    this.compartmentId = creds.compartmentOcid;
    this.homeRegion = creds.region;
    // The SDK signs every request with the private key (in memory — nothing
    // is written to disk, and the key is never logged).
    this.auth = new common.SimpleAuthenticationDetailsProvider(
      creds.tenancyOcid,
      creds.userOcid,
      creds.fingerprint,
      creds.privateKey,
      creds.passphrase ?? null
    );
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /** The API clients for a region (made once, then reused). */
  private clients(region: string = this.homeRegion): RegionClients {
    let set = this.clientsByRegion.get(region);
    if (!set) {
      const params = { authenticationDetailsProvider: this.auth };
      set = {
        compute: new core.ComputeClient(params, CLIENT_CONFIG),
        network: new core.VirtualNetworkClient(params, CLIENT_CONFIG),
        storage: new core.BlockstorageClient(params, CLIENT_CONFIG),
        identity: new identity.IdentityClient(params, CLIENT_CONFIG),
      };
      // Each region has its own API address, e.g. iaas.ap-singapore-1.oraclecloud.com.
      set.compute.regionId = region;
      set.network.regionId = region;
      set.storage.regionId = region;
      set.identity.regionId = region;
      this.clientsByRegion.set(region, set);
    }
    return set;
  }

  /** "ap-singapore-1/ocid1.instance..." -> { region, ocid }. A bare OCID uses the home region. */
  private splitId(id: string): { region: string; ocid: string } {
    const slash = id.indexOf('/');
    if (slash === -1) return { region: this.homeRegion, ocid: id };
    const region = id.slice(0, slash);
    const ocid = id.slice(slash + 1);
    if (!REGION_RE.test(region) || !ocid.startsWith('ocid1.')) {
      throw new Error(`Not an Oracle id (expected "region/ocid"): ${id}`);
    }
    return { region, ocid };
  }

  /**
   * Ask `fetch` every `intervalMs` until `isDone` says yes. `isFailed` can
   * return a reason to stop early. `onWait` is called about once a minute so
   * we can tell the user we're still waiting. Returns the last value.
   */
  private async waitFor<T>(opts: {
    what: string;
    fetch: () => Promise<T>;
    isDone: (value: T) => boolean;
    isFailed?: (value: T) => string | undefined;
    timeoutMs: number;
    intervalMs?: number;
    onWait?: (value: T, elapsedSec: number) => Promise<void>;
    throwOnTimeout?: boolean;
  }): Promise<T> {
    const started = Date.now();
    const interval = opts.intervalMs ?? 10_000;
    let lastNote = started;
    for (;;) {
      const value = await opts.fetch();
      if (opts.isDone(value)) return value;
      const failure = opts.isFailed?.(value);
      if (failure) throw new Error(failure);
      if (Date.now() - started > opts.timeoutMs) {
        if (opts.throwOnTimeout === false) return value;
        throw new Error(`Timed out after ${Math.round(opts.timeoutMs / 60000)} minutes waiting for ${opts.what}.`);
      }
      if (opts.onWait && Date.now() - lastNote >= 60_000) {
        lastNote = Date.now();
        await opts.onWait(value, Math.round((Date.now() - started) / 1000));
      }
      await sleep(interval);
    }
  }

  /** Every page of an Oracle "list" call, flattened. */
  private async listAll<T>(call: (page?: string) => Promise<{ items: T[]; opcNextPage?: string }>): Promise<T[]> {
    const all: T[] = [];
    let page: string | undefined;
    do {
      const res = await call(page);
      all.push(...res.items);
      page = res.opcNextPage || undefined;
    } while (page);
    return all;
  }

  /** Regions this tenancy is subscribed to (others must be subscribed in the console first). */
  async getSubscribedRegions(): Promise<string[]> {
    const { identity: id } = this.clients(this.homeRegion);
    const res = await id.listRegionSubscriptions({ tenancyId: this.tenancyOcid });
    return res.items.filter((r) => String(r.status) === 'READY').map((r) => String(r.regionName));
  }

  /**
   * The A10 GPU service limit in a region, summed over its availability
   * domains: { limit, used }. Oracle limits are per availability domain and
   * start at 0 on new accounts. Returns null if no A10 limit is listed.
   */
  async getGpuLimit(region: string): Promise<{ limit: number; used: number } | null> {
    const client = new limits.LimitsClient({ authenticationDetailsProvider: this.auth }, CLIENT_CONFIG);
    client.regionId = region;
    const values = await client.listLimitValues({ compartmentId: this.tenancyOcid, serviceName: 'compute' });
    const a10 = values.items.filter((v) => /a10/i.test(String(v.name)) && !/bm|bare/i.test(String(v.name)));
    if (!a10.length) return null;
    let limit = 0; let used = 0;
    for (const v of a10) {
      limit += Number(v.value) || 0;
      if ((Number(v.value) || 0) > 0 && v.availabilityDomain) {
        try {
          const av = await client.getResourceAvailability({ serviceName: 'compute', limitName: String(v.name), compartmentId: this.tenancyOcid, availabilityDomain: v.availabilityDomain });
          used += Number(av.resourceAvailability.used) || 0;
        } catch { /* usage is a nice-to-have */ }
      }
    }
    return { limit, used };
  }

  /** The availability domains of a region, e.g. ["Uocm:AP-SINGAPORE-1-AD-1"]. */
  async listAvailabilityDomains(region: string = this.homeRegion): Promise<string[]> {
    const { identity: id } = this.clients(region);
    const res = await id.listAvailabilityDomains({ compartmentId: this.tenancyOcid });
    return res.items.map((ad) => ad.name || '').filter(Boolean);
  }

  /** The public IP of an instance (via its network card, the "VNIC"), or ''. */
  private async publicIp(region: string, instance: core.models.Instance): Promise<string> {
    const { compute, network } = this.clients(region);
    const attachments = await compute.listVnicAttachments({ compartmentId: instance.compartmentId, instanceId: instance.id });
    for (const att of attachments.items) {
      if (att.lifecycleState !== 'ATTACHED' || !att.vnicId) continue;
      const { vnic } = await network.getVnic({ vnicId: att.vnicId });
      if (vnic.publicIp) return vnic.publicIp;
    }
    return '';
  }

  /** Oracle's instance states -> ours. */
  private mapState(state: string): Status {
    switch (state) {
      case 'PROVISIONING':
      case 'STARTING':
      case 'MOVING':
      case 'CREATING_IMAGE':
        return 'starting';
      case 'RUNNING':
        return 'running';
      case 'STOPPING':
        return 'stopping';
      case 'STOPPED':
        return 'stopped';
      case 'TERMINATING':
      case 'TERMINATED':
        return 'terminated';
      default:
        return 'unknown';
    }
  }

  /** Get an instance, or undefined if Oracle says it doesn't exist. */
  private async findInstance(region: string, ocid: string): Promise<core.models.Instance | undefined> {
    try {
      const { instance } = await this.clients(region).compute.getInstance({ instanceId: ocid });
      return instance;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /**
   * Oracle Ubuntu images ship with a host firewall (iptables) that blocks
   * every incoming port except SSH — on top of the cloud-level security list.
   * This bash snippet opens the Sunshine ports inside the machine too, and
   * saves the rules so they survive reboots. `-C` checks first, so running it
   * on every boot doesn't pile up duplicate rules.
   */
  private hostFirewallSnippet(): string {
    const ports = (protocol: 'tcp' | 'udp') =>
      SUNSHINE_PORT_RANGES.filter((r) => r.protocol === protocol)
        .map((r) => (r.from === r.to ? String(r.from) : `${r.from}:${r.to}`))
        .join(',');
    const rule = (protocol: 'tcp' | 'udp') => `INPUT -p ${protocol} -m multiport --dports ${ports(protocol)} -j ACCEPT`;
    return [
      '# ---- Oracle Cloud: open the streaming ports in the machine\'s own firewall ----',
      '# (Oracle\'s Ubuntu images block everything except SSH with iptables.)',
      'if command -v iptables >/dev/null 2>&1; then',
      `  iptables -C ${rule('tcp')} 2>/dev/null || iptables -I ${rule('tcp')}`,
      `  iptables -C ${rule('udp')} 2>/dev/null || iptables -I ${rule('udp')}`,
      '  # Oracle\'s images also REJECT all forwarded traffic, which blocks the ports',
      '  # Docker publishes for the Sunshine container (a well-known Docker-on-OCI',
      '  # pitfall). Remove that one rule; Docker manages forwarding itself.',
      '  while iptables -D FORWARD -j REJECT --reject-with icmp-host-prohibited 2>/dev/null; do :; done',
      '  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1 || true; fi',
      'fi',
      '',
    ].join('\n');
  }

  /**
   * The shared setup script with our Oracle firewall snippet inserted right
   * after the "#!/bin/bash" line (which must stay the very first line, or
   * cloud-init won't know how to run it).
   */
  private buildOracleScript(sunshineUsername: string, sunshinePassword: string, autoStopMinutes?: number, nickname?: string): string {
    const script = buildSetupScript({ sunshineUsername, sunshinePassword, autoStopMinutes, serverName: nickname });
    const newline = script.indexOf('\n');
    return script.slice(0, newline + 1) + this.hostFirewallSnippet() + script.slice(newline + 1);
  }

  // ==========================================================================
  // Networking: make sure "cloudgaming-vcn" exists and is wired to the internet
  // ==========================================================================

  /** The firewall rules we want: Sunshine ports from anywhere + ICMP "fragmentation needed". */
  private desiredIngressRules(): core.models.IngressSecurityRule[] {
    const rules: core.models.IngressSecurityRule[] = SUNSHINE_PORT_RANGES.map((r) => {
      const range = { destinationPortRange: { min: r.from, max: r.to } };
      return {
        protocol: r.protocol === 'tcp' ? '6' : '17', // Oracle wants IP protocol NUMBERS: 6 = TCP, 17 = UDP
        source: '0.0.0.0/0',
        sourceType: core.models.IngressSecurityRule.SourceType.CidrBlock,
        isStateless: false,
        description: `Sunshine/Moonlight ${r.protocol.toUpperCase()} ${r.from}${r.to !== r.from ? `-${r.to}` : ''}`,
        ...(r.protocol === 'tcp' ? { tcpOptions: range } : { udpOptions: range }),
      };
    });
    // ICMP type 3 code 4 lets "packet too big" messages in, so large video
    // packets don't silently vanish (Oracle's default list has this too).
    rules.push({
      protocol: '1',
      source: '0.0.0.0/0',
      sourceType: core.models.IngressSecurityRule.SourceType.CidrBlock,
      isStateless: false,
      icmpOptions: { type: 3, code: 4 },
      description: 'Path MTU discovery',
    });
    return rules;
  }

  /** Does the security list already contain every rule we want? */
  private hasAllRules(existing: core.models.IngressSecurityRule[]): boolean {
    const key = (r: core.models.IngressSecurityRule) => {
      const range = r.tcpOptions?.destinationPortRange || r.udpOptions?.destinationPortRange;
      return `${r.protocol}|${r.source}|${range?.min ?? ''}-${range?.max ?? ''}|${r.icmpOptions?.type ?? ''}`;
    };
    const have = new Set(existing.map(key));
    return this.desiredIngressRules().every((r) => have.has(key(r)));
  }

  /**
   * Make sure our network exists in this region, repairing any missing piece.
   * Returns the id of the public subnet machines go in. Idempotent: on the
   * second launch it just finds everything and returns quickly.
   */
  private async ensureNetwork(region: string): Promise<string> {
    const { network } = this.clients(region);
    const compartmentId = this.compartmentId;
    const alive = (s?: string) => s !== 'TERMINATED' && s !== 'TERMINATING';

    // 1. The VCN (virtual cloud network) itself.
    const vcns = await network.listVcns({ compartmentId, displayName: VCN_NAME });
    let vcn = vcns.items.find((v) => alive(v.lifecycleState));
    if (vcn) {
      await this.report('info', `Network "${VCN_NAME}" already exists in ${region} — checking it's complete…`);
    } else {
      await this.report('info', `Creating network "${VCN_NAME}" in ${region} (one-time, ~30 s)…`,
        'Oracle has no default network, so we make one: a VCN, an internet gateway, a route to the internet, a firewall (security list) and a public subnet.');
      const created = await network.createVcn({
        createVcnDetails: {
          compartmentId,
          displayName: VCN_NAME,
          cidrBlocks: [VCN_CIDR],
          dnsLabel: 'cloudgaming',
          freeformTags: freeformTags(),
        },
      });
      vcn = created.vcn;
    }
    const vcnId = vcn.id;
    vcn = await this.waitFor({
      what: 'the network to be ready',
      fetch: async () => (await network.getVcn({ vcnId })).vcn,
      isDone: (v) => v.lifecycleState === 'AVAILABLE',
      timeoutMs: 5 * 60_000,
      intervalMs: 3_000,
    });

    // 2. Internet gateway (the VCN's door to the internet).
    const igws = await network.listInternetGateways({ compartmentId, vcnId, displayName: IGW_NAME });
    let igw = igws.items.find((g) => alive(g.lifecycleState));
    if (!igw) {
      await this.report('info', 'Adding an internet gateway to the network…');
      igw = (await network.createInternetGateway({
        createInternetGatewayDetails: { compartmentId, vcnId, displayName: IGW_NAME, isEnabled: true, freeformTags: freeformTags() },
      })).internetGateway;
    }
    const igId = igw.id;
    await this.waitFor({
      what: 'the internet gateway to be ready',
      fetch: async () => (await network.getInternetGateway({ igId })).internetGateway,
      isDone: (g) => g.lifecycleState === 'AVAILABLE',
      timeoutMs: 5 * 60_000,
      intervalMs: 3_000,
    });

    // 3. Route "everything not local (0.0.0.0/0) → internet gateway" in the
    //    VCN's default route table.
    const rtId = vcn.defaultRouteTableId!;
    const { routeTable } = await network.getRouteTable({ rtId });
    const defaultRoute = routeTable.routeRules.find((r) => (r.destination || r.cidrBlock) === '0.0.0.0/0');
    if (!defaultRoute) {
      await this.report('info', 'Adding a route to the internet…');
      await network.updateRouteTable({
        rtId,
        updateRouteTableDetails: {
          routeRules: [
            ...routeTable.routeRules,
            {
              destination: '0.0.0.0/0',
              destinationType: core.models.RouteRule.DestinationType.CidrBlock,
              networkEntityId: igId,
              description: 'Gints Global Gaming Hubjob: internet access',
            },
          ],
        },
      });
    } else if (defaultRoute.networkEntityId !== igId) {
      await this.report('warn', 'The network\'s default route points somewhere other than our internet gateway — leaving it alone. If the machine gets no internet, check the route table of "cloudgaming-vcn".');
    }

    // 4. Security list (Oracle's firewall) opening the streaming ports.
    const lists = await network.listSecurityLists({ compartmentId, vcnId, displayName: STREAMING_FIREWALL_NAME });
    let secList = lists.items.find((l) => alive(l.lifecycleState));
    const egressAll: core.models.EgressSecurityRule[] = [{
      protocol: 'all',
      destination: '0.0.0.0/0',
      destinationType: core.models.EgressSecurityRule.DestinationType.CidrBlock,
      isStateless: false,
      description: 'Allow all outgoing traffic (downloads, streaming)',
    }];
    if (!secList) {
      await this.report('info', `Creating firewall "${STREAMING_FIREWALL_NAME}" to open the streaming ports…`,
        SUNSHINE_PORT_RANGES.map((r) => `${r.protocol.toUpperCase()} ${r.from}${r.to !== r.from ? `-${r.to}` : ''}`).join(' · '));
      secList = (await network.createSecurityList({
        createSecurityListDetails: {
          compartmentId,
          vcnId,
          displayName: STREAMING_FIREWALL_NAME,
          ingressSecurityRules: this.desiredIngressRules(),
          egressSecurityRules: egressAll,
          freeformTags: freeformTags(),
        },
      })).securityList;
    } else if (!this.hasAllRules(secList.ingressSecurityRules)) {
      await this.report('info', `Updating firewall "${STREAMING_FIREWALL_NAME}" — some streaming ports were missing…`);
      await network.updateSecurityList({
        securityListId: secList.id,
        updateSecurityListDetails: { ingressSecurityRules: this.desiredIngressRules(), egressSecurityRules: egressAll },
      });
    }
    const securityListId = secList.id;

    // 5. The public subnet machines are placed in.
    const subnets = await network.listSubnets({ compartmentId, vcnId, displayName: SUBNET_NAME });
    let subnet = subnets.items.find((s) => alive(s.lifecycleState));
    if (!subnet) {
      await this.report('info', 'Creating a public subnet for game machines…');
      subnet = (await network.createSubnet({
        createSubnetDetails: {
          compartmentId,
          vcnId,
          displayName: SUBNET_NAME,
          cidrBlock: SUBNET_CIDR,
          dnsLabel: 'public',
          routeTableId: rtId,
          securityListIds: [securityListId],
          prohibitPublicIpOnVnic: false, // "public" subnet: machines may have public IPs
          freeformTags: freeformTags(),
        },
      })).subnet;
    } else if (!subnet.securityListIds?.includes(securityListId)) {
      await this.report('info', 'Attaching the streaming firewall to the subnet…');
      await network.updateSubnet({
        subnetId: subnet.id,
        updateSubnetDetails: { securityListIds: [...(subnet.securityListIds || []), securityListId] },
      });
    }
    const subnetId = subnet.id;
    await this.waitFor({
      what: 'the subnet to be ready',
      fetch: async () => (await network.getSubnet({ subnetId })).subnet,
      isDone: (s) => s.lifecycleState === 'AVAILABLE',
      timeoutMs: 5 * 60_000,
      intervalMs: 3_000,
    });
    await this.report('success', 'Network ready: internet access and streaming ports are open.');
    return subnetId;
  }

  /**
   * The newest Canonical Ubuntu 22.04 image Oracle says works on this shape.
   * (Oracle refreshes its images monthly, so we look it up instead of
   * hard-coding an id.) Skips ARM ("aarch64") and "Minimal" images, and
   * prefers a plain image over a GPU one so our script installs the driver.
   */
  private async findUbuntuImage(region: string, shapeId: string): Promise<core.models.Image> {
    const { compute } = this.clients(region);
    const res = await compute.listImages({
      compartmentId: this.compartmentId,
      operatingSystem: IMAGE_OS,
      operatingSystemVersion: IMAGE_OS_VERSION,
      shape: shapeId,
      sortBy: core.requests.ListImagesRequest.SortBy.Timecreated,
      sortOrder: core.requests.ListImagesRequest.SortOrder.Desc,
      lifecycleState: 'AVAILABLE',
    });
    const usable = res.items.filter((i) => !/aarch64|minimal/i.test(i.displayName || ''));
    const image = usable.find((i) => !/gpu/i.test(i.displayName || '')) || usable[0];
    if (!image) {
      throw new FriendlyCloudError({
        code: 'OCI_NO_UBUNTU_IMAGE',
        title: `No Ubuntu 22.04 image for ${shapeId} in ${region}`,
        explanation: 'Oracle didn\'t list any Canonical Ubuntu 22.04 image compatible with this GPU shape in this region — usually because the shape isn\'t offered here.',
        fixes: ['Pick a different region or GPU shape.'],
      });
    }
    return image;
  }

  /**
   * Create one machine, trying each availability domain of the region until
   * one works. Shared by launchInstance (fresh Ubuntu disk + setup script) and
   * restoreFromSnapshot (disk copied from a backup, already set up).
   */
  private async createMachine(
    config: ProviderConfig,
    options: { spot: boolean; diskSizeGb: number; script?: string; backupOcid?: string; nickname?: string }
  ): Promise<{ instanceId: string; ipAddress: string; costPerHour: number }> {
    const shape = findShape(config.instanceType);
    if (!shape) {
      throw new FriendlyCloudError({
        code: 'UNKNOWN_SHAPE',
        title: `Unknown machine type "${config.instanceType}"`,
        explanation: 'This machine type isn\'t one Gints Global Gaming Hubjob knows how to launch on Oracle Cloud.',
        fixes: [`Choose one of: ${ORACLE_SHAPES.map((s) => `${s.label} (${s.id})`).join(', ')}.`],
      });
    }
    const region = config.region || this.homeRegion;
    if (!REGION_RE.test(region)) {
      throw new FriendlyCloudError({
        code: 'UNKNOWN_REGION',
        title: `"${region}" isn't an Oracle region`,
        explanation: 'Oracle region ids look like ap-singapore-1 or us-ashburn-1.',
        fixes: [`Choose one of: ${ORACLE_REGIONS.map((r) => `${r.name} (${r.id})`).join(', ')}.`],
      });
    }
    const known = findRegion(region);
    if (known && !known.gpus.includes(shape.gpuModel)) {
      await this.report('warn', `As far as we know, Oracle doesn't offer ${shape.gpuModel} GPUs in ${known.name} — trying anyway, but expect a "not available" error.`);
    }

    await this.report('info', `Compartment ${this.compartmentId === this.tenancyOcid ? '(root of your tenancy)' : this.compartmentId} · ${shape.label} · ${known?.name || region} (${region})` +
      `${options.spot ? ' · PREEMPTIBLE (≈50% cheaper; Oracle can reclaim it at any time, and it can\'t be stopped — only deleted)' : ''}`);

    const subnetId = await this.ensureNetwork(region);
    const { compute, storage } = this.clients(region);

    let image: core.models.Image | undefined;
    if (!options.backupOcid) {
      await this.report('info', `Looking up the newest ${IMAGE_OS} ${IMAGE_OS_VERSION} image for ${shape.id}…`);
      image = await this.findUbuntuImage(region, shape.id);
      await this.report('success', `Using image "${image.displayName}".`);
    }

    const ads = await this.listAvailabilityDomains(region);
    if (!ads.length) throw new Error(`Oracle returned no availability domains for ${region}.`);
    await this.report('info', `${region} has ${ads.length} availability domain${ads.length === 1 ? '' : 's'} (data centres): ${ads.join(', ')}.`);

    const name = `cg-${crypto.randomBytes(4).toString('hex')}`;
    const adErrors: unknown[] = [];

    for (const ad of ads) {
      await this.report('info', `Trying ${ad}…`);
      let bootVolumeId: string | undefined;
      let instanceOcid: string | undefined;
      try {
        // Restoring: the disk must first be re-created from the backup, in THIS AD.
        if (options.backupOcid) {
          await this.report('info', `Re-creating the disk from backup in ${ad} (a few minutes)…`);
          const { bootVolume } = await storage.createBootVolume({
            createBootVolumeDetails: {
              availabilityDomain: ad,
              compartmentId: this.compartmentId,
              displayName: `${name}-boot`,
              freeformTags: freeformTags(),
              sourceDetails: { type: 'bootVolumeBackup', id: options.backupOcid },
            },
          });
          bootVolumeId = bootVolume.id;
          const volId = bootVolume.id;
          await this.waitFor({
            what: 'the restored disk',
            fetch: async () => (await storage.getBootVolume({ bootVolumeId: volId })).bootVolume,
            isDone: (v) => v.lifecycleState === 'AVAILABLE',
            isFailed: (v) => (v.lifecycleState === 'FAULTY' || v.lifecycleState === 'TERMINATED' ? `Restored disk is ${v.lifecycleState}` : undefined),
            timeoutMs: 30 * 60_000,
            onWait: (_v, s) => this.report('info', `Still restoring the disk… (${Math.round(s / 60)} min)`),
          });
          await this.report('success', 'Disk restored.');
        }

        const details: core.models.LaunchInstanceDetails = {
          availabilityDomain: ad,
          compartmentId: this.compartmentId,
          displayName: name,
          shape: shape.id,
          // "cg-nickname" is read by the machine at every boot (Sunshine's name).
          freeformTags: { ...freeformTags(), ...(options.nickname ? { 'cg-nickname': options.nickname } : {}) },
          createVnicDetails: { subnetId, assignPublicIp: true, displayName: `${name}-vnic` },
          sourceDetails: bootVolumeId
            ? { sourceType: 'bootVolume', bootVolumeId }
            : { sourceType: 'image', imageId: image!.id, bootVolumeSizeInGBs: options.diskSizeGb },
          // cloud-init runs "user_data" on first boot. It must be base64, and
          // all metadata together is capped at 32 KB, so it's gzipped (cloud-init
          // unpacks gzip itself). Only the setup script goes here — no other secrets.
          metadata: options.script ? { user_data: zlib.gzipSync(Buffer.from(options.script, 'utf8'), { level: 9 }).toString('base64') } : undefined,
          preemptibleInstanceConfig: options.spot
            ? { preemptionAction: { type: 'TERMINATE', preserveBootVolume: false } }
            : undefined,
        };
        // No automatic retries here: "Out of host capacity" is a 500 error
        // the SDK would otherwise retry 8 times, slowly, in the same AD.
        const { instance } = await compute.launchInstance({
          launchInstanceDetails: details,
          retryConfiguration: common.NoRetryConfigurationDetails,
        });
        instanceOcid = instance.id;
        await this.report('info', `Oracle accepted the request — ${name} is being created in ${ad} (GPU machines usually take 2–5 minutes)…`);

        const ready = await this.waitFor({
          what: `${name} to start`,
          fetch: async () => (await compute.getInstance({ instanceId: instance.id })).instance,
          isDone: (i) => i.lifecycleState === 'RUNNING',
          // Oracle sometimes accepts a launch and then gives up on it.
          isFailed: (i) => (i.lifecycleState === 'TERMINATED' || i.lifecycleState === 'TERMINATING'
            ? 'Oracle terminated the machine while provisioning it (usually: Out of host capacity).'
            : undefined),
          timeoutMs: 20 * 60_000,
          onWait: (i, s) => this.report('info', `Still ${String(i.lifecycleState).toLowerCase()}… (${Math.round(s / 60)} min so far)`),
        });

        // The machine is up: from here on, never let a hiccup delete it.
        const ipAddress = await this.publicIp(region, ready).catch(() => '');
        await this.report('success', `Machine ${name} is running in ${ad}${ipAddress ? ` with public IP ${ipAddress}` : ''}.`);
        if (options.script) {
          await this.report('info', 'The machine is now installing the NVIDIA driver, desktop, Sunshine and Steam by itself (about 10–20 minutes, including one reboot). Watch the setup progress bar.');
        }
        return {
          instanceId: `${region}/${instance.id}`,
          ipAddress,
          costPerHour: estimateHourly(shape.id, region, options.spot),
        };
      } catch (error: any) {
        // Clean up anything half-made in this AD before moving on.
        if (instanceOcid) {
          await compute.terminateInstance({ instanceId: instanceOcid, preserveBootVolume: false }).catch(() => undefined);
        } else if (bootVolumeId) {
          await storage.deleteBootVolume({ bootVolumeId }).catch(() => undefined);
        }
        if (isOracleAdSpecificError(error)) {
          adErrors.push(error);
          const why = isOracleCapacityError(error)
            ? 'no spare GPU machines right now'
            : /LimitExceeded|service limit/i.test(String(error?.serviceCode) + String(error?.message))
              ? 'your GPU service limit here is used up (limits are per availability domain)'
              : 'this shape isn\'t available here';
          await this.report('warn', `${ad}: ${why} — trying the next availability domain.`, String(error?.message || error));
          continue;
        }
        // Permission, credentials, bad request... would fail in every AD: stop now.
        throw error;
      }
    }

    // Every AD failed. Throw the most useful error: capacity (temporary) if any
    // AD said so, otherwise the last one (e.g. the service limit).
    await this.report('warn', `No availability domain in ${region} could create the machine.`);
    throw adErrors.find(isOracleCapacityError) || adErrors[adErrors.length - 1];
  }

  // ==========================================================================
  // The CloudProvider contract
  // ==========================================================================

  /** Free-form tag "cg-nickname" (readable from inside the machine via its metadata service). */
  async setNickname(instanceId: string, nickname: string): Promise<boolean> {
    const { region, ocid } = this.splitId(instanceId);
    const { compute } = this.clients(region);
    const { instance } = await compute.getInstance({ instanceId: ocid });
    await compute.updateInstance({ instanceId: ocid, updateInstanceDetails: { freeformTags: { ...(instance.freeformTags || {}), 'cg-nickname': nickname } } });
    return true;
  }

  async launchInstance(
    config: ProviderConfig,
    options: LaunchOptions
  ): Promise<{ instanceId: string; ipAddress: string; costPerHour: number }> {
    // (options.imageId / keyName / securityGroupId are AWS-era fields: ignored.)
    const sunshineUsername = options.sunshineUsername || 'gamer';
    const sunshinePassword = options.sunshinePassword || crypto.randomBytes(12).toString('base64url');
    return this.createMachine(
      { region: config.region || this.homeRegion, instanceType: config.instanceType || DEFAULT_SHAPE },
      {
        spot: !!options.spotInstance,
        diskSizeGb: Math.max(50, options.diskSizeGb || 150), // Oracle's minimum boot volume is 50 GB
        script: this.buildOracleScript(sunshineUsername, sunshinePassword, options.autoStopMinutes, options.nickname),
        nickname: options.nickname,
      }
    );
  }

  async stopInstance(instanceId: string): Promise<void> {
    const { region, ocid } = this.splitId(instanceId);
    const { compute } = this.clients(region);
    const { instance } = await compute.getInstance({ instanceId: ocid });
    if (instance.preemptibleInstanceConfig) {
      throw new FriendlyCloudError({
        code: 'OCI_PREEMPTIBLE_CANT_STOP',
        title: 'Preemptible Oracle machines can\'t be stopped',
        explanation: 'Oracle only lets preemptible machines run or be deleted — there is no "stopped" state for them.',
        fixes: [
          'Take a snapshot first if you want to keep your games and settings, then delete the machine.',
          'Later, restore the snapshot to a new machine.',
        ],
      });
    }
    if (instance.lifecycleState === 'STOPPED') {
      await this.report('info', `${instance.displayName} is already stopped.`);
      return;
    }

    // SOFTSTOP = ask the operating system to shut down cleanly (like pressing
    // the power button). If it hasn't finished in 5 minutes, force it (STOP).
    await this.report('info', `Asking Oracle to shut down ${instance.displayName} cleanly…`);
    await compute.instanceAction({ instanceId: ocid, action: 'SOFTSTOP' });
    const soft = await this.waitFor({
      what: `${instance.displayName} to stop`,
      fetch: async () => (await compute.getInstance({ instanceId: ocid })).instance,
      isDone: (i) => i.lifecycleState === 'STOPPED',
      timeoutMs: 5 * 60_000,
      throwOnTimeout: false,
      onWait: (_i, s) => this.report('info', `Still shutting down… (${Math.round(s / 60)} min)`),
    });
    if (soft.lifecycleState !== 'STOPPED') {
      await this.report('warn', 'Clean shutdown is taking too long — forcing the machine off.');
      await compute.instanceAction({ instanceId: ocid, action: 'STOP' });
      await this.waitFor({
        what: `${instance.displayName} to stop`,
        fetch: async () => (await compute.getInstance({ instanceId: ocid })).instance,
        isDone: (i) => i.lifecycleState === 'STOPPED',
        timeoutMs: 10 * 60_000,
      });
    }
    await this.report('success', `${instance.displayName} is stopped. You still pay a little for its disk.`);

    // Some Oracle shapes keep billing while stopped. Oracle tells us which.
    try {
      const shapes = await compute.listShapes({
        compartmentId: instance.compartmentId,
        availabilityDomain: instance.availabilityDomain,
        shape: instance.shape,
      });
      if (shapes.items.find((s) => s.shape === instance.shape)?.isBilledForStoppedInstance) {
        await this.report('warn', `Oracle keeps charging for ${instance.shape} machines even while stopped. To stop all compute charges, snapshot it and delete it instead.`);
      }
    } catch {
      /* purely informational */
    }
  }

  async startInstance(instanceId: string): Promise<void> {
    const { region, ocid } = this.splitId(instanceId);
    const { compute } = this.clients(region);
    await this.report('info', 'Asking Oracle to start the machine…');
    await compute.instanceAction({ instanceId: ocid, action: 'START' });
    const instance = await this.waitFor({
      what: 'the machine to start',
      fetch: async () => (await compute.getInstance({ instanceId: ocid })).instance,
      isDone: (i) => i.lifecycleState === 'RUNNING',
      isFailed: (i) => (i.lifecycleState === 'TERMINATED' ? 'The machine was deleted while starting.' : undefined),
      timeoutMs: 15 * 60_000,
      onWait: (_i, s) => this.report('info', `Still starting… (${Math.round(s / 60)} min) — if Oracle has no spare GPUs right now this can take a while.`),
    });
    const ip = await this.publicIp(region, instance);
    await this.report('success', `${instance.displayName} is running${ip ? ` at ${ip}` : ''}. (Oracle normally keeps the same public IP across stop/start.)`);
  }

  async terminateInstance(instanceId: string): Promise<void> {
    const { region, ocid } = this.splitId(instanceId);
    const { compute } = this.clients(region);
    const instance = await this.findInstance(region, ocid);
    if (!instance || instance.lifecycleState === 'TERMINATED') {
      await this.report('warn', 'The machine was already gone at Oracle (deleted elsewhere?). Cleaning up our record.');
      return;
    }
    await this.report('info', `Asking Oracle to delete ${instance.displayName} and its disk…`);
    try {
      await compute.terminateInstance({ instanceId: ocid, preserveBootVolume: false });
    } catch (error) {
      if (isNotFound(error)) {
        await this.report('warn', 'The machine was already gone at Oracle. Cleaning up our record.');
        return;
      }
      throw error;
    }
    const final = await this.waitFor({
      what: 'the machine to be deleted',
      fetch: async () => (await this.findInstance(region, ocid))?.lifecycleState ?? 'TERMINATED',
      isDone: (s) => s === 'TERMINATED',
      timeoutMs: 10 * 60_000,
      throwOnTimeout: false,
    });
    if (final === 'TERMINATED') {
      await this.report('success', `${instance.displayName} deleted — it no longer costs anything.`);
    } else {
      await this.report('info', `Oracle is still deleting ${instance.displayName}; billing has already stopped.`);
    }
  }

  async getInstanceStatus(instanceId: string): Promise<{ status: Status; ipAddress?: string }> {
    const { region, ocid } = this.splitId(instanceId);
    const instance = await this.findInstance(region, ocid);
    if (!instance) return { status: 'terminated' };
    const status = this.mapState(String(instance.lifecycleState));
    if (status !== 'running') return { status };
    let ipAddress: string | undefined;
    try {
      ipAddress = (await this.publicIp(region, instance)) || undefined;
    } catch {
      /* status is still useful without the IP */
    }
    return { status, ipAddress };
  }

  /**
   * Actual charges from Oracle's Usage API, daily, in the tenancy's billing
   * currency. Oracle can't split out only what this app created, so it's the
   * compartment the app uses when one is set, otherwise the whole tenancy.
   * Needs the policy: Allow group <group> to read usage-report in tenancy
   */
  /**
   * Invoices from Oracle's OSP Gateway (Pay-As-You-Go / Universal Credits):
   * amount, amount still due, due date and status. Needs the policy
   * "Allow group … to read invoices in tenancy".
   */
  async getInvoices(): Promise<CloudInvoices> {
    const client = new ospgateway.InvoiceServiceClient({ authenticationDetailsProvider: this.auth }, CLIENT_CONFIG);
    client.regionId = this.homeRegion;
    const end = new Date();
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 6, 1));
    let items: any[] = [];
    try {
      const res = await client.listInvoices({ ospHomeRegion: this.homeRegion, compartmentId: this.tenancyOcid, timeInvoiceStart: start, timeInvoiceEnd: end });
      items = res.invoiceCollection?.items || [];
    } catch (error: any) {
      if (error?.statusCode === 404 || error?.statusCode === 401 || error?.statusCode === 403 || /NotAuthorized/i.test(String(error?.serviceCode))) {
        throw new FriendlyCloudError({
          code: 'BILLING_PERMISSION', title: 'Your Oracle key can\'t read invoices',
          explanation: 'Oracle\'s invoice service needs its own policy statement.',
          fixes: ['Add to your CloudGaming policy (root compartment): Allow group CloudGaming to read invoices in tenancy'],
          consoleUrl: 'https://cloud.oracle.com/identity/domains/policies', consoleLabel: 'Open Policies',
        });
      }
      throw error;
    }
    const day = (t: any) => (t ? new Date(t).toISOString().slice(0, 10) : undefined);
    const invoices: CloudInvoice[] = items.map((i: any) => ({
      id: String(i.invoiceNumber || i.invoiceId), issued: day(i.timeInvoice), due: day(i.timeInvoiceDue), period: day(i.timeInvoice)?.slice(0, 7),
      amount: i.invoiceAmount ?? null, balance: i.invoiceAmountDue ?? null, currency: String(i.currency?.currencyCode || 'USD'),
      status: i.isPaid ? 'Paid' : i.invoiceStatus ? String(i.invoiceStatus).replace(/_/g, ' ').toLowerCase() : undefined,
    })).sort((a: CloudInvoice, b: CloudInvoice) => String(b.issued).localeCompare(String(a.issued)));
    return { invoices, consoleUrl: 'https://cloud.oracle.com/invoices', consoleLabel: 'Open Invoices' };
  }

  async getBillingActuals(from: string, to: string): Promise<BillingActuals> {
    const client = new usageapi.UsageapiClient({ authenticationDetailsProvider: this.auth }, CLIENT_CONFIG);
    client.regionId = this.homeRegion;
    const ownCompartment = this.compartmentId && this.compartmentId !== this.tenancyOcid ? this.compartmentId : null;
    let items: usageapi.models.UsageSummary[] = [];
    try {
      const res = await client.requestSummarizedUsages({
        requestSummarizedUsagesDetails: {
          tenantId: this.tenancyOcid,
          timeUsageStarted: new Date(`${from}T00:00:00Z`),
          timeUsageEnded: new Date(`${to}T00:00:00Z`),
          granularity: usageapi.models.RequestSummarizedUsagesDetails.Granularity.Daily,
          queryType: usageapi.models.RequestSummarizedUsagesDetails.QueryType.Cost,
          groupBy: ['compartmentId'],
          compartmentDepth: 6,
        },
      });
      items = res.usageAggregation?.items || [];
    } catch (error: any) {
      if (error?.statusCode === 404 || error?.statusCode === 401 || /NotAuthorized/i.test(String(error?.serviceCode))) {
        throw new FriendlyCloudError({
          code: 'BILLING_PERMISSION', title: 'Your Oracle key can\'t read cost data',
          explanation: 'Oracle\'s Usage API needs its own policy statement.',
          fixes: ['Identity & Security → Policies (root compartment) → edit your CloudGaming policy and add:',
            'Allow group CloudGaming to read usage-report in tenancy'],
          consoleUrl: 'https://cloud.oracle.com/identity/domains/policies', consoleLabel: 'Open Policies',
        });
      }
      throw error;
    }
    const scoped = new Map<string, number>();
    const account = new Map<string, number>();
    let currency = 'USD';
    for (const it of items) {
      const date = new Date(it.timeUsageStarted).toISOString().slice(0, 10);
      const amount = Number(it.computedAmount) || 0;
      if (it.currency) currency = String(it.currency).trim();
      account.set(date, (account.get(date) || 0) + amount);
      if (ownCompartment && it.compartmentId === ownCompartment) scoped.set(date, (scoped.get(date) || 0) + amount);
    }
    const toDays = (m: Map<string, number>) => [...m.entries()].sort().map(([date, amount]) => ({ date, amount }));
    return ownCompartment
      ? { currency, scope: 'compartment', scopeNote: 'The compartment the app uses', daily: toDays(scoped), accountDaily: toDays(account) }
      : { currency, scope: 'account', scopeNote: 'Whole tenancy (the app uses the root compartment)', daily: toDays(account),
          notes: ['Set a dedicated compartment on Config to see only this app\'s costs.'] };
  }

  async createSnapshot(instanceId: string, _diskPath: string): Promise<{ snapshotId: string; sizeGb: number }> {
    // Our machines have one disk (the boot volume); we back it up whole.
    const { region, ocid } = this.splitId(instanceId);
    const { compute, storage } = this.clients(region);
    const { instance } = await compute.getInstance({ instanceId: ocid });
    const attachments = await compute.listBootVolumeAttachments({
      availabilityDomain: instance.availabilityDomain,
      compartmentId: instance.compartmentId,
      instanceId: ocid,
    });
    const bootVolumeId = attachments.items.find((a) => a.lifecycleState === 'ATTACHED')?.bootVolumeId;
    if (!bootVolumeId) throw new Error(`Couldn't find the disk (boot volume) of ${instance.displayName}.`);
    const { bootVolume } = await storage.getBootVolume({ bootVolumeId });

    await this.report('info', `Backing up the ${bootVolume.sizeInGBs} GB disk of ${instance.displayName} (games and settings included). Oracle takes a few minutes up to ~30 for this…`);
    const { bootVolumeBackup } = await storage.createBootVolumeBackup({
      createBootVolumeBackupDetails: {
        bootVolumeId,
        displayName: `${instance.displayName}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
        type: core.models.CreateBootVolumeBackupDetails.Type.Full,
        freeformTags: freeformTags(),
      },
    });
    const backupId = bootVolumeBackup.id;
    const done = await this.waitFor({
      what: 'the backup',
      fetch: async () => (await storage.getBootVolumeBackup({ bootVolumeBackupId: backupId })).bootVolumeBackup,
      isDone: (b) => b.lifecycleState === 'AVAILABLE',
      isFailed: (b) => (b.lifecycleState === 'FAULTY' || b.lifecycleState === 'TERMINATED' ? `Oracle reports the backup as ${b.lifecycleState}.` : undefined),
      timeoutMs: 45 * 60_000,
      intervalMs: 20_000,
      throwOnTimeout: false,
      onWait: (_b, s) => this.report('info', `Backup still in progress… (${Math.round(s / 60)} min)`),
    });
    if (done.lifecycleState === 'AVAILABLE') {
      await this.report('success', `Snapshot ${done.displayName} is ready.`);
    } else {
      await this.report('warn', `Snapshot ${done.displayName} is still being created at Oracle — it will show as ready when finished.`);
    }
    return { snapshotId: `${region}/${backupId}`, sizeGb: Number(bootVolume.sizeInGBs) || 0 };
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotInfo> {
    const { region, ocid } = this.splitId(snapshotId);
    const { bootVolumeBackup: b } = await this.clients(region).storage.getBootVolumeBackup({ bootVolumeBackupId: ocid });
    const state = String(b.lifecycleState);
    return {
      id: snapshotId,
      sizeGb: Number(b.sizeInGBs) || 0,
      state: state === 'AVAILABLE' ? 'completed' : state === 'FAULTY' || state === 'TERMINATED' ? 'failed' : 'pending',
      storedGb: Number(b.uniqueSizeInGBs) || undefined,
    };
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    const { region, ocid } = this.splitId(snapshotId);
    await this.report('info', 'Deleting the snapshot (boot volume backup) at Oracle…');
    try {
      await this.clients(region).storage.deleteBootVolumeBackup({ bootVolumeBackupId: ocid });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await this.report('success', 'Snapshot deleted — it no longer costs anything.');
  }

  async restoreFromSnapshot(snapshotId: string, config: ProviderConfig, opts: RestoreOptions = {}): Promise<{ instanceId: string; ipAddress: string }> {
    const { region, ocid } = this.splitId(snapshotId);
    const target = config.region || region;
    if (target !== region) {
      throw new FriendlyCloudError({
        code: 'OCI_SNAPSHOT_OTHER_REGION',
        title: `This snapshot is in ${region}, not ${target}`,
        explanation: 'Oracle backups can only be restored in the region they\'re stored in.',
        fixes: [`Copy (replicate) the snapshot to ${target} first, then restore the copy — or restore it in ${region}.`],
      });
    }
    await this.report('info', 'Creating a new machine from your snapshot (your games and settings come with it)…');
    // No setup script: the disk already has everything installed, including
    // the setup service and the Sunshine login you set before.
    const { instanceId, ipAddress } = await this.createMachine(
      { region, instanceType: config.instanceType || DEFAULT_SHAPE },
      { spot: !!opts.spot, diskSizeGb: opts.diskSizeGb || 150, backupOcid: ocid, nickname: opts.nickname }
    );
    return { instanceId, ipAddress };
  }

  async replicateSnapshot(
    sourceSnapshotId: string,
    sourceProvider: string,
    sourceRegion: string,
    targetRegion: string
  ): Promise<{ snapshotId: string }> {
    if (sourceProvider !== 'oracle') {
      throw new FriendlyCloudError({
        code: 'CROSS_CLOUD_UNSUPPORTED',
        title: 'Copying snapshots from another cloud into Oracle isn\'t supported yet',
        explanation: 'Each cloud stores disks in its own format; converting between them isn\'t built yet.',
        fixes: ['Launch a fresh machine on Oracle Cloud instead.'],
      });
    }
    const { region, ocid } = this.splitId(sourceSnapshotId.includes('/') ? sourceSnapshotId : `${sourceRegion}/${sourceSnapshotId}`);
    if (region === targetRegion) return { snapshotId: `${region}/${ocid}` };

    await this.report('info', `Copying the snapshot from ${region} to ${targetRegion}. Oracle does this in the background; it can take from minutes to over an hour for big disks.`);
    // The copy is requested from the SOURCE region; the new backup lives in the target.
    const res = await this.clients(region).storage.copyBootVolumeBackup({
      bootVolumeBackupId: ocid,
      copyBootVolumeBackupDetails: { destinationRegion: targetRegion },
    });
    await this.report('success', `Copy started. It shows as ready once Oracle has finished (inter-region transfer is billed per GB by Oracle).`);
    return { snapshotId: `${targetRegion}/${res.bootVolumeBackup.id}` };
  }

  async getRegions(): Promise<RegionData[]> {
    return ORACLE_REGIONS.map((r) => ({
      provider: 'oracle',
      name: r.name,
      region: r.id,
      lat: r.lat,
      lng: r.lng,
      onDemandPrice: estimateHourly(DEFAULT_SHAPE, r.id),
      spotPrice: estimateHourly(DEFAULT_SHAPE, r.id, true),
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
    // The first 10 TB/month of egress are free on Oracle — more than a heavy
    // gamer streams — so the practical cost per GB is 0.
    return findRegion(region)?.egressPerGb ?? 0;
  }

  async queryCosts(): Promise<{ computeCost: number; egressCost: number; storageCost: number }> {
    throw new FriendlyCloudError({
      code: 'OCI_COSTS_UNAVAILABLE',
      title: 'Actual Oracle Cloud spend isn\'t available yet',
      explanation:
        'Reading real spend needs Oracle\'s Usage API, which isn\'t connected yet. Costs shown here are estimates from running time.',
      fixes: ['See exact spend in the Oracle console under Billing & Cost Management → Cost Analysis.'],
    });
  }

  // ==========================================================================
  // Inventory: everything we've created, for the infrastructure map
  // ==========================================================================

  /**
   * Everything Gints Global Gaming Hubjob has created in this Oracle account, in every
   * region we might have used: the user's home region plus each catalog
   * region the tenancy is subscribed to. Regions are read in parallel; a
   * region that fails (e.g. a subscription still being set up) is skipped,
   * but if EVERY region fails we throw the first error — that's almost
   * always a credential or permission problem, which the caller turns into
   * a friendly message. Finding nothing is not an error: it returns [].
   */
  async listResources(): Promise<InventoryItem[]> {
    // Which regions to look in. The subscription call is the first thing we
    // ask Oracle, so bad credentials fail right here (which is what we want).
    const subscribed = await this.listSubscribedRegions();
    const catalogIds = new Set(ORACLE_REGIONS.map((r) => r.id));
    const regions = new Set<string>([this.homeRegion]);
    for (const r of subscribed) {
      if (catalogIds.has(r.name) && r.status === 'READY') regions.add(r.name);
    }

    const results = await Promise.allSettled(Array.from(regions).map((region) => this.listRegionResources(region)));
    const items: InventoryItem[] = [];
    const errors: unknown[] = [];
    for (const res of results) {
      if (res.status === 'fulfilled') items.push(...res.value);
      else errors.push(res.reason);
    }
    if (errors.length && errors.length === results.length) throw errors[0];
    return items;
  }

  /**
   * Everything of ours in ONE region. We make one "list" call per kind of
   * resource (plus one boot-volume-attachment call per availability domain
   * that actually holds one of our disks or machines), then match things up
   * locally. Individual lists may fail (e.g. the API user may be allowed to
   * read compute but not networking); we keep whatever worked and only throw
   * if nothing did.
   */
  private async listRegionResources(region: string): Promise<InventoryItem[]> {
    const { compute, network, storage } = this.clients(region);
    const compartmentId = this.compartmentId;
    const link = (path: string) => `https://cloud.oracle.com/${path}?region=${region}`;
    const lower = (s: unknown) => String(s ?? 'unknown').toLowerCase();
    const iso = (d?: Date | string) => (d ? new Date(d).toISOString() : undefined);
    const alive = (s?: string) => s !== 'TERMINATED';
    // "Ours" = carries our freeform tag app=cloudgaming-hub, or follows our
    // naming: machines are "cg-xxxxxxxx", their disks "cg-xxxxxxxx (Boot
    // Volume)" or "cg-xxxxxxxx-boot", backups "cg-xxxxxxxx-<date>".
    const tagged = (tags?: { [key: string]: string }) => tags?.[RESOURCE_TAG.key] === RESOURCE_TAG.value;
    const ours = (x: { freeformTags?: { [key: string]: string }; displayName?: string }) =>
      tagged(x.freeformTags) || String(x.displayName || '').startsWith('cg-');

    // All the independent list calls at once.
    const [instancesRes, volumesRes, backupsRes, vcnsRes, igwsRes, listsRes, subnetsRes, ipsRes] = await Promise.allSettled([
      this.listAll((page) => compute.listInstances({ compartmentId, page })),
      this.listAll((page) => storage.listBootVolumes({ compartmentId, page })),
      this.listAll((page) => storage.listBootVolumeBackups({ compartmentId, page })),
      this.listAll((page) => network.listVcns({ compartmentId, displayName: VCN_NAME, page })),
      this.listAll((page) => network.listInternetGateways({ compartmentId, displayName: IGW_NAME, page })),
      this.listAll((page) => network.listSecurityLists({ compartmentId, displayName: STREAMING_FIREWALL_NAME, page })),
      this.listAll((page) => network.listSubnets({ compartmentId, displayName: SUBNET_NAME, page })),
      this.listAll((page) => network.listPublicIps({
        scope: core.requests.ListPublicIpsRequest.Scope.Region,
        lifetime: core.requests.ListPublicIpsRequest.Lifetime.Reserved,
        compartmentId,
        page,
      })),
    ]);
    const all = [instancesRes, volumesRes, backupsRes, vcnsRes, igwsRes, listsRes, subnetsRes, ipsRes];
    if (all.every((r) => r.status === 'rejected')) throw (instancesRes as PromiseRejectedResult).reason;
    const got = <T>(r: PromiseSettledResult<T[]>): T[] => (r.status === 'fulfilled' ? r.value : []);

    const items: InventoryItem[] = [];

    // ---- Machines ----------------------------------------------------------
    const instances = got(instancesRes).filter((i) => alive(i.lifecycleState) && ours(i));
    const ourInstanceIds = new Set(instances.map((i) => i.id));
    for (const i of instances) {
      // Preemptible ("spot") machines carry a preemptibleInstanceConfig.
      const preemptible = !!i.preemptibleInstanceConfig;
      items.push({
        provider: 'oracle',
        type: 'vm',
        id: i.id,
        name: i.displayName || i.id,
        region,
        zone: i.availabilityDomain,
        status: lower(i.lifecycleState),
        instanceId: `${region}/${i.id}`,
        hourlyCost: estimateHourly(i.shape, region, preemptible),
        consoleUrl: link(`compute/instances/${i.id}`),
        createdAt: iso(i.timeCreated),
      });
    }

    // ---- Disks (boot volumes) ---------------------------------------------
    // Which machine each disk is plugged into comes from "boot volume
    // attachments", which Oracle only lists per availability domain. We ask
    // only in the ADs that hold one of our disks or machines.
    const allVolumes = got(volumesRes);
    const attachedTo = new Map<string, string>(); // boot volume OCID -> instance OCID
    let attachmentsKnown = true;
    const ads = new Set<string>(instances.map((i) => i.availabilityDomain));
    for (const v of allVolumes) if (alive(v.lifecycleState) && ours(v)) ads.add(v.availabilityDomain);
    await Promise.all(Array.from(ads).map(async (availabilityDomain) => {
      try {
        const atts = await this.listAll((page) => compute.listBootVolumeAttachments({ availabilityDomain, compartmentId, page }));
        for (const a of atts) {
          if (a.lifecycleState === 'ATTACHED' || a.lifecycleState === 'ATTACHING') attachedTo.set(a.bootVolumeId, a.instanceId);
        }
      } catch {
        attachmentsKnown = false; // don't call disks "orphans" if we couldn't check
      }
    }));
    // Our disks: tagged/named ours, or plugged into one of our machines.
    const volumes = allVolumes.filter((v) => alive(v.lifecycleState) &&
      (ours(v) || ourInstanceIds.has(attachedTo.get(v.id) || '')));
    for (const v of volumes) {
      const owner = attachedTo.get(v.id);
      const sizeGb = Number(v.sizeInGBs) || 0;
      const orphan = attachmentsKnown && !owner && v.lifecycleState === 'AVAILABLE';
      items.push({
        provider: 'oracle',
        type: 'disk',
        id: v.id,
        name: v.displayName || v.id,
        region,
        zone: v.availabilityDomain,
        status: owner ? 'in-use' : lower(v.lifecycleState),
        attachedTo: owner ? `${region}/${owner}` : undefined,
        sizeGb,
        monthlyCost: Math.round(sizeGb * BOOT_VOLUME_PER_GB_MONTH * 100) / 100,
        orphan: orphan || undefined,
        orphanReason: orphan ? 'Disk (boot volume) not attached to any machine — it is still billed' : undefined,
        consoleUrl: link(`block-storage/boot-volumes/${v.id}`),
        createdAt: iso(v.timeCreated),
      });
    }

    // ---- Snapshots (boot volume backups) ----------------------------------
    // "Orphan" = the disk it was taken from no longer exists. We can only
    // judge that if we managed to list this region's boot volumes, and not
    // for backups COPIED from another region (their source disk lives there).
    const volumesListed = volumesRes.status === 'fulfilled';
    const liveVolumeIds = new Set(allVolumes.filter((v) => alive(v.lifecycleState)).map((v) => v.id));
    for (const b of got(backupsRes)) {
      if (!alive(b.lifecycleState) || !ours(b)) continue;
      const sizeGb = Number(b.sizeInGBs) || 0;
      const copied = !!b.sourceBootVolumeBackupId;
      const orphan = volumesListed && !copied && !!b.bootVolumeId && !liveVolumeIds.has(b.bootVolumeId);
      items.push({
        provider: 'oracle',
        type: 'snapshot',
        id: b.id,
        name: b.displayName || b.id,
        region,
        status: lower(b.lifecycleState),
        sizeGb,
        monthlyCost: Math.round(sizeGb * BACKUP_PER_GB_MONTH * 100) / 100,
        orphan: orphan || undefined,
        orphanReason: orphan ? 'Snapshot of a disk that no longer exists (its machine was deleted) — still billed for storage' : undefined,
        consoleUrl: link(`block-storage/boot-volume-backups/${b.id}`),
        createdAt: iso(b.timeCreated),
      });
    }

    // ---- Network pieces (free on Oracle) ----------------------------------
    const net = (
      type: InventoryItem['type'],
      x: { id: string; displayName?: string; lifecycleState?: string; timeCreated?: Date },
      path: string
    ) => {
      if (!alive(x.lifecycleState)) return;
      items.push({
        provider: 'oracle',
        type,
        id: x.id,
        name: x.displayName || x.id,
        region,
        status: lower(x.lifecycleState),
        consoleUrl: link(path),
        createdAt: iso(x.timeCreated),
      });
    };
    for (const v of got(vcnsRes)) net('network', v, `networking/vcns/${v.id}`);
    for (const g of got(igwsRes)) net('gateway', g, `networking/vcns/${g.vcnId}/internet-gateways/${g.id}`);
    for (const l of got(listsRes)) net('firewall', l, `networking/vcns/${l.vcnId}/security-lists/${l.id}`);
    for (const s of got(subnetsRes)) net('subnet', s, `networking/vcns/${s.vcnId}/subnets/${s.id}`);

    // ---- Reserved public IPs ----------------------------------------------
    // We don't create these (our machines get "ephemeral" IPs that vanish
    // with them), but we list any that carry our tag/name. Oracle doesn't
    // charge for reserved IPs, so the cost is 0; an unassigned one is still
    // flagged as a leftover so it can be tidied up. (Tracing an assigned IP
    // back to its machine would take extra calls per IP, so attachedTo is
    // left empty.)
    for (const ip of got(ipsRes)) {
      if (ip.lifecycleState === 'TERMINATED' || !ip.id || !ours(ip)) continue;
      const assigned = !!ip.assignedEntityId;
      items.push({
        provider: 'oracle',
        type: 'public-ip',
        id: ip.id,
        name: ip.displayName || ip.ipAddress || ip.id,
        region,
        status: assigned ? 'in-use' : lower(ip.lifecycleState),
        monthlyCost: 0,
        orphan: !assigned || undefined,
        orphanReason: assigned ? undefined : 'Reserved public IP not assigned to any machine',
        consoleUrl: link('networking/ip-management/public-ips'),
        createdAt: iso(ip.timeCreated),
      });
    }

    return items;
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.getUser();
      return true;
    } catch (error) {
      // Only the message — never the credentials.
      console.error('[Oracle] credential check failed:', toFriendlyError(error, 'oracle').title);
      return false;
    }
  }

  // ==========================================================================
  // Oracle-specific extras (used by oracle/checks.ts and the machine pages)
  // ==========================================================================

  /** The API user (proves the key works). Throws on failure. */
  async getUser(): Promise<identity.models.User> {
    const { user } = await this.clients().identity.getUser({ userId: this.userOcid });
    return user;
  }

  /** Regions this tenancy is subscribed to, e.g. [{ name: 'ap-singapore-1', status: 'READY', home: true }]. */
  async listSubscribedRegions(): Promise<Array<{ name: string; status: string; home: boolean }>> {
    const res = await this.clients().identity.listRegionSubscriptions({ tenancyId: this.tenancyOcid });
    return res.items.map((r) => ({ name: r.regionName, status: String(r.status), home: !!r.isHomeRegion }));
  }

  /** The compartment's name, or 'tenancy' when it's the root. */
  async getCompartmentName(): Promise<string> {
    if (this.compartmentId === this.tenancyOcid) return 'tenancy';
    const { compartment } = await this.clients().identity.getCompartment({ compartmentId: this.compartmentId });
    return compartment.name;
  }

  /** Permission probes (read-only): each throws if the API user can't list that kind of thing. */
  async probeInstances(region = this.homeRegion): Promise<void> {
    await this.clients(region).compute.listInstances({ compartmentId: this.compartmentId, limit: 1 });
  }
  async probeNetworks(region = this.homeRegion): Promise<void> {
    await this.clients(region).network.listVcns({ compartmentId: this.compartmentId, limit: 1 });
  }
  async probeVolumes(region = this.homeRegion): Promise<void> {
    await this.clients(region).storage.listBootVolumeBackups({ compartmentId: this.compartmentId, limit: 1 });
  }

  /**
   * Which of our GPU shapes Oracle lists for this tenancy, per availability
   * domain of a region. (A shape being listed doesn't prove the service limit
   * is above 0, but a missing one means it can't be launched there.)
   */
  async listGpuShapes(region = this.homeRegion): Promise<Array<{ ad: string; shapes: string[] }>> {
    const wanted = new Set(ORACLE_SHAPES.map((s) => s.id));
    const out: Array<{ ad: string; shapes: string[] }> = [];
    for (const ad of await this.listAvailabilityDomains(region)) {
      const shapes = await this.listAll((page) =>
        this.clients(region).compute.listShapes({ compartmentId: this.compartmentId, availabilityDomain: ad, page })
      );
      out.push({ ad, shapes: Array.from(new Set(shapes.map((s) => s.shape).filter((s) => wanted.has(s)))) });
    }
    return out;
  }

  /**
   * Read the machine's serial console (via Oracle "console history") and
   * extract the setup stages printed by the setup script. Oracle makes us
   * request a capture, wait for it, read it, then we delete it again so
   * captures don't pile up. Returns [] if anything goes wrong.
   */
  async getSetupProgress(instanceId: string): Promise<SetupStage[]> {
    let historyId: string | undefined;
    const { region, ocid } = this.splitId(instanceId);
    const { compute } = this.clients(region);
    try {
      const { consoleHistory } = await compute.captureConsoleHistory({
        captureConsoleHistoryDetails: { instanceId: ocid, displayName: 'cloudgaming-setup-progress', freeformTags: freeformTags() },
      });
      historyId = consoleHistory.id;
      const id = consoleHistory.id;
      const ready = await this.waitFor({
        what: 'the console capture',
        fetch: async () => (await compute.getConsoleHistory({ instanceConsoleHistoryId: id })).consoleHistory,
        isDone: (h) => h.lifecycleState === 'SUCCEEDED' || h.lifecycleState === 'FAILED',
        timeoutMs: 30_000,
        intervalMs: 2_000,
      });
      if (ready.lifecycleState !== 'SUCCEEDED') return [];
      // Up to 1 MB of the most recent console output.
      const content = await compute.getConsoleHistoryContent({ instanceConsoleHistoryId: id, offset: 0, length: 1024 * 1024 });
      return parseSetupStages(String(content.value || ''));
    } catch {
      return [];
    } finally {
      if (historyId) await compute.deleteConsoleHistory({ instanceConsoleHistoryId: historyId }).catch(() => undefined);
    }
  }
}
