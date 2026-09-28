/**
 * ============================================================================
 * src/providers/AzureProvider.ts — MICROSOFT AZURE
 * ============================================================================
 *
 * The Azure version of the CloudProvider contract (Provider.ts). It creates,
 * starts, stops, deletes and snapshots GPU virtual machines in the USER'S OWN
 * Azure subscription, using the "service principal" login they added on the
 * Config page (stored encrypted — see CredentialService.ts).
 *
 * AZURE WORDS YOU'LL SEE BELOW
 * ----------------------------
 * - SUBSCRIPTION: the billing account everything is created in (a GUID).
 * - SERVICE PRINCIPAL ("app registration"): a robot login for programs.
 *   It has a tenant ID (which Microsoft Entra directory it lives in), a
 *   client ID (its username) and a client secret (its password).
 * - LOCATION: Azure's word for region, e.g. 'southeastasia'.
 * - RESOURCE GROUP: a folder for Azure resources. We keep one per location,
 *   "cloudgaming-hub-<location>", so everything we create is easy to find
 *   (and, in an emergency, to delete in one go in the Azure portal).
 * - A VM on Azure is several separate resources that we create one by one:
 *     public IP address → network card ("NIC", attached to our virtual
 *     network and firewall) → the VM itself (which creates its OS disk).
 *   The firewall is a "network security group" (NSG), shared by all our
 *   machines in the location, opening only the Sunshine streaming ports.
 * - LONG-RUNNING OPERATIONS: creating things takes a while. The SDK's
 *   `beginXxxAndWait` methods start the operation and poll Azure until it's
 *   finished (or failed), so a simple `await` is enough.
 *
 * OUR INSTANCE ID is "resourceGroup/vmName", e.g.
 * "cloudgaming-hub-southeastasia/cg-3f1c9e2a"; snapshot ids use the same
 * "resourceGroup/snapshotName" format.
 *
 * STOPPED ≠ STOPPED ON AZURE
 * --------------------------
 * Azure has two kinds of "off": "Stopped" (the OS is shut down but Azure
 * keeps the hardware reserved — and KEEPS BILLING for it) and "Stopped
 * (deallocated)" (hardware given back — compute billing stops). We always
 * DEALLOCATE. The disk and the static public IP are still billed while
 * deallocated (a few cents a day).
 *
 * NO SSH: the machine configures itself with the shared setup script
 * (shared/setupScript.ts), handed to Azure as "custom data" (cloud-init runs
 * it on first boot). We watch its progress in the serial console log via
 * Azure "boot diagnostics". An SSH key IS required by Azure to create a
 * Linux VM, so we generate a throwaway one and discard the private half —
 * nobody can log in, and nobody needs to.
 *
 * CREDENTIALS SHAPE
 * -----------------
 *   { tenantId, clientId, clientSecret, subscriptionId }
 * ============================================================================
 */

import crypto from 'crypto';
import { ClientSecretCredential } from '@azure/identity';
import { ComputeManagementClient } from '@azure/arm-compute';
import type { VirtualMachine, Snapshot } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import { CloudProvider, ProviderConfig, LaunchOptions, SnapshotInfo, RestoreOptions } from './Provider';
import { RegionData } from '../types';
// Shared errors module FIRST (it loads every cloud's rule list), then ours.
import { FriendlyCloudError } from './errors';
import { isAzureNotFound, PORTAL, CREATE_SP_COMMAND } from './azure/errors';
import {
  AZURE_REGIONS,
  AZURE_SHAPES,
  OS_DISK_SKU,
  PREMIUM_DISK_PER_GB_MONTH,
  SNAPSHOT_PER_GB_MONTH,
  UBUNTU_IMAGE,
  estimateHourly,
  findRegion,
  findShape,
  resourceGroupFor,
} from './azure/catalog';
import type { InventoryItem, BillingActuals, BillingDay } from './shared/types';
import { buildSetupScript, parseSetupStages, SetupStage } from './shared/setupScript';
import { RESOURCE_TAG, STREAMING_FIREWALL_NAME, SUNSHINE_PORT_RANGES } from './shared/streaming';

/** The parsed, checked credentials. */
export interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
}

/** Subscription facts from Azure (used by the credential checks). */
export interface AzureSubscriptionInfo {
  subscriptionId: string;
  displayName: string;
  state: string;       // 'Enabled', 'Warned', 'PastDue', 'Disabled', 'Deleted'
  quotaId?: string;    // the offer type, e.g. 'PayAsYouGo_2014-09-01', 'FreeTrial_2014-09-01'
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A tenant can also be given as its domain name, e.g. contoso.onmicrosoft.com. */
const TENANT_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** Azure Resource Manager — the API everything goes through. */
const ARM = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';

/** Names of the shared things we create once per location. */
const VNET_NAME = 'cloudgaming-vnet';
const SUBNET_NAME = 'default';
const NSG_NAME = STREAMING_FIREWALL_NAME;   // 'cloudgaming-sunshine'
const ADMIN_USER = 'azureuser';             // required by Azure; nobody logs in with it

/** Tags on everything we create (shows up in the Azure portal and cost reports). */
const TAGS: Record<string, string> = { [RESOURCE_TAG.key]: RESOURCE_TAG.value };

/** The resources that make up one machine, named after it. */
function partNames(vmName: string) {
  return { nic: `${vmName}-nic`, ip: `${vmName}-ip`, disk: `${vmName}-osdisk` };
}

/**
 * Pull the resource group and name out of a full Azure resource id, e.g.
 * "/subscriptions/…/resourceGroups/RG/providers/Microsoft.Network/networkInterfaces/NAME".
 */
function parseArmId(id: string | undefined): { rg: string; name: string } | undefined {
  const m = String(id || '').match(/\/resourceGroups\/([^/]+)\/providers\/[^/]+\/[^/]+\/([^/]+)$/i);
  return m ? { rg: m[1], name: m[2] } : undefined;
}

// ---------------------------------------------------------------------------
// Inventory helpers (used by listResources)
// ---------------------------------------------------------------------------

/** The prefix of every resource group we create (see resourceGroupFor in azure/catalog.ts). */
const RG_PREFIX = 'cloudgaming-hub-';

/** A link to any resource in the Azure portal, from its full resource id. */
function portalLink(id: string | undefined): string | undefined {
  return id ? `https://portal.azure.com/#@/resource${id}` : undefined;
}

/** Read every page of one of the SDK's "list" results into a plain array. */
async function collect<T>(pages: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of pages) out.push(item);
  return out;
}

/**
 * Azure bills managed disks by SIZE TIER, rounded UP: a 150 GB disk is
 * billed as the 256 GiB tier. These are the tier sizes (GiB) Azure uses for
 * Premium SSD (P1…P80), Standard SSD (E1…E80) and Standard HDD (S4…S80).
 */
const DISK_TIERS_GB = [4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32767];

/**
 * Rough $/month for a managed disk: tier size × a per-GB rate by disk type.
 * East US list prices, approximately:
 *   - Premium SSD (Premium_LRS, what we create): ~$0.15/GB of the TIER
 *     (256 GiB "P15" ≈ $38/month) — PREMIUM_DISK_PER_GB_MONTH in the catalog.
 *   - Standard SSD: ~$0.075/GB of the tier (256 GiB "E15" ≈ $19).
 *   - Standard HDD: ~$0.045/GB of the tier (plus per-transaction fees we ignore).
 *   - Premium SSD v2 / Ultra: billed by the exact GB (plus IOPS/throughput we ignore).
 *   - Zone-redundant (…_ZRS) copies cost about 1.5× the locally-redundant (…_LRS) ones.
 * It's an ESTIMATE; the UI shows it with "≈".
 */
function estimateDiskMonthly(sizeGb: number, sku: string | undefined): number {
  if (!sizeGb) return 0;
  const name = String(sku || OS_DISK_SKU);
  const tierGb = DISK_TIERS_GB.find((t) => t >= sizeGb) ?? sizeGb;
  let cost: number;
  if (/^PremiumV2|^UltraSSD/i.test(name)) cost = sizeGb * 0.12;        // exact size, no tiers
  else if (/^Premium/i.test(name)) cost = tierGb * PREMIUM_DISK_PER_GB_MONTH;
  else if (/^StandardSSD/i.test(name)) cost = tierGb * 0.075;
  else cost = tierGb * 0.045;                                           // Standard_LRS = HDD
  if (/_ZRS$/i.test(name)) cost *= 1.5;
  return Math.round(cost * 100) / 100;
}

/** A Standard (static) public IPv4 address: ~$0.005/hour ≈ $3.65/month, attached or not. */
const STATIC_IP_PER_MONTH = 3.65;

/**
 * The VM's power state in plain words, from the "PowerState/…" code in its
 * instance view. Azure's special case: "stopped" means shut down but still
 * ALLOCATED — still billed as if running — so we say so.
 */
function vmStatusWords(codes: string[], provisioningState?: string): string {
  const power = codes.find((c) => c.startsWith('powerstate/'))?.split('/')[1];
  switch (power) {
    case 'running': return 'running';
    case 'deallocated': return 'deallocated';
    case 'deallocating': return 'deallocating';
    case 'stopped': return 'stopped (still billed)';
    case 'starting': return 'starting';
    case 'stopping': return 'stopping';
    case undefined: break;
    default: return power;
  }
  const provisioning = codes.find((c) => c.startsWith('provisioningstate/'))?.split('/')[1] || String(provisioningState || '').toLowerCase();
  if (provisioning === 'creating' || provisioning === 'updating') return 'creating';
  if (provisioning === 'deleting') return 'deleting';
  if (provisioning === 'failed') return 'failed';
  return 'unknown';
}

/**
 * VM security settings to try, in order — both keep SECURE BOOT OFF so the
 * NVIDIA driver (built on the machine, unsigned) can load:
 *   1. "Standard": plain VM, no UEFI security features at all. Simplest.
 *   2. "TrustedLaunch" with Secure Boot switched off (the virtual TPM chip
 *      stays on — harmless). Used if the subscription or API refuses an
 *      explicit "Standard" (older API versions required a feature flag,
 *      "UseStandardSecurityType", for that).
 * The NCasT4_v3 sizes we offer are gen2 and support both.
 */
const SECURITY_PROFILES: Array<{ label: string; profile: NonNullable<VirtualMachine['securityProfile']> }> = [
  { label: 'Standard', profile: { securityType: 'Standard' } },
  { label: 'Trusted Launch without Secure Boot', profile: { securityType: 'TrustedLaunch', uefiSettings: { secureBootEnabled: false, vTpmEnabled: true } } },
];

/** Did Azure reject the VM because of its security type (so the next option might work)? */
function isSecurityTypeRejection(error: unknown): boolean {
  const e = error as any;
  const text = `${typeof e?.code === 'string' ? e.code : ''} ${e?.message || ''}`;
  return /securityType|securityProfile|UseStandardSecurityType|TrustedLaunch|uefiSettings|secureBoot/i.test(text);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Azure insists on an SSH public key (or a password) for Linux VMs. We make
 * a throwaway RSA key pair, keep only the public half in OpenSSH format
 * ("ssh-rsa AAAA…") and throw the private half away: login is impossible,
 * which is exactly what we want — the machine sets itself up.
 */
function throwawaySshPublicKey(): string {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  // OpenSSH format = base64 of: string "ssh-rsa", mpint e, mpint n
  // (each prefixed by a 4-byte length; mpints get a 0x00 if the top bit is set).
  const field = (b: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  const mpint = (b64url: string) => {
    const raw = Buffer.from(b64url, 'base64url');
    return raw[0] & 0x80 ? Buffer.concat([Buffer.from([0]), raw]) : raw;
  };
  const blob = Buffer.concat([field(Buffer.from('ssh-rsa')), field(mpint(jwk.e)), field(mpint(jwk.n))]);
  return `ssh-rsa ${blob.toString('base64')} cloudgaming-hub-no-login`;
}

/**
 * Azure-only lines added to the top of the shared setup script. Azure's
 * Ubuntu kernel ("linux-azure") leaves some graphics kernel modules (e.g.
 * drm) in a separate "linux-modules-extra" package; the NVIDIA driver and
 * Xorg need them. CloudyPad installs it for the same reason. It runs once,
 * best-effort (never stops the setup), before the driver step.
 */
const AZURE_SCRIPT_PRELUDE = String.raw`
# --- Azure extra (added by AzureProvider): kernel modules the GPU driver needs ---
if [ "$(printenv CG_FROM_UNIT)" = "1" ] && [ ! -f /var/lib/cloudgaming/azure-modules.done ]; then
  mkdir -p /var/lib/cloudgaming
  apt-get -o DPkg::Lock::Timeout=900 -y update >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=900 -y install "linux-modules-extra-$(uname -r)" >/dev/null 2>&1 || true
  touch /var/lib/cloudgaming/azure-modules.done
fi
# --- end Azure extra ---
`;

function azureSetupScript(sunshineUsername: string, sunshinePassword: string, autoStopMinutes?: number): string {
  const script = buildSetupScript({ sunshineUsername, sunshinePassword, autoStopMinutes });
  // Keep the "#!/bin/bash" line first (cloud-init needs it to run the file as a script).
  const firstNewline = script.indexOf('\n');
  return script.slice(0, firstNewline + 1) + AZURE_SCRIPT_PRELUDE + script.slice(firstNewline + 1);
}

export class AzureProvider extends CloudProvider {
  name = 'azure' as const;
  readonly selfConfiguring = true;

  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly clientId: string;

  private credential: ClientSecretCredential;
  private compute: ComputeManagementClient;
  private network: NetworkManagementClient;
  private resources: ResourceManagementClient;

  /**
   * Turn whatever was stored into checked credentials, or throw a friendly
   * error explaining exactly what's wrong with them. Also used by the
   * Config page checks (azure/checks.ts) as the "format" check.
   */
  static parseCredentials(raw: any): AzureCredentials {
    let input = raw ?? {};
    // Convenience: accept the JSON that `az ad sp create-for-rbac` prints
    // ({ appId, password, tenant }) pasted as a whole into any field.
    for (const value of Object.values(input)) {
      if (typeof value === 'string' && value.trim().startsWith('{')) {
        try {
          const json = JSON.parse(value);
          input = {
            tenantId: json.tenant ?? json.tenantId ?? input.tenantId,
            clientId: json.appId ?? json.clientId ?? input.clientId,
            clientSecret: json.password ?? json.clientSecret ?? input.clientSecret,
            subscriptionId: json.subscriptionId ?? input.subscriptionId,
          };
        } catch { /* not JSON after all — validated below */ }
        break;
      }
    }

    const tenantId = String(input.tenantId ?? '').trim();
    const clientId = String(input.clientId ?? '').trim();
    const clientSecret = String(input.clientSecret ?? '').trim();
    const subscriptionId = String(input.subscriptionId ?? '').trim();

    const problems: string[] = [];
    if (!tenantId) problems.push('Tenant ID is empty.');
    else if (!GUID.test(tenantId) && !TENANT_DOMAIN.test(tenantId)) {
      problems.push('Tenant ID should look like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (or yourname.onmicrosoft.com).');
    }
    if (!clientId) problems.push('Client ID is empty.');
    else if (!GUID.test(clientId)) problems.push('Client ID (the app\'s "Application (client) ID" / "appId") should look like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.');
    if (!subscriptionId) problems.push('Subscription ID is empty.');
    else if (!GUID.test(subscriptionId)) problems.push('Subscription ID should look like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx — the ID, not the subscription\'s name.');
    if (!clientSecret) problems.push('Client secret is empty.');
    else if (GUID.test(clientSecret)) {
      problems.push('The client secret looks like a "Secret ID" (a GUID). You need the secret\'s VALUE — a ~40-character string shown only once when the secret is created.');
    }
    if (clientId && clientId === subscriptionId) problems.push('Client ID and Subscription ID are the same — one of them is probably pasted into the wrong box.');
    if (clientId && clientId === tenantId) problems.push('Client ID and Tenant ID are the same — one of them is probably pasted into the wrong box.');

    if (problems.length) {
      throw new FriendlyCloudError({
        code: 'AZURE_CREDENTIALS_FORMAT',
        title: 'Some Azure details don\'t look right',
        explanation: problems.join(' '),
        fixes: [
          'The easiest way to get all four values: open Azure Cloud Shell (the >_ icon at the top of the portal) and run:',
          CREATE_SP_COMMAND,
          'It prints "appId" (= Client ID), "password" (= Client secret) and "tenant" (= Tenant ID). Your Subscription ID is on the Subscriptions page.',
        ],
        consoleUrl: PORTAL.subscriptions,
        consoleLabel: 'Open Subscriptions',
      });
    }
    return { tenantId, clientId, clientSecret, subscriptionId };
  }

  constructor(credentials: any) {
    super();
    const creds = AzureProvider.parseCredentials(credentials);
    this.subscriptionId = creds.subscriptionId;
    this.tenantId = creds.tenantId;
    this.clientId = creds.clientId;

    // One login object shared by every client. It fetches (and caches) an
    // access token from Microsoft Entra ID using the client secret; the
    // secret itself never leaves this process except to Microsoft.
    this.credential = new ClientSecretCredential(creds.tenantId, creds.clientId, creds.clientSecret);
    this.compute = new ComputeManagementClient(this.credential, creds.subscriptionId);
    this.network = new NetworkManagementClient(this.credential, creds.subscriptionId);
    this.resources = new ResourceManagementClient(this.credential, creds.subscriptionId);
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /** "rg/name" -> { rg, name } */
  private splitId(id: string): { rg: string; name: string } {
    const [rg, name] = String(id).split('/');
    if (!rg || !name) throw new Error(`Not an Azure id (expected "resourceGroup/name"): ${id}`);
    return { rg, name };
  }

  /**
   * A raw call to Azure Resource Manager for the few things the SDK
   * packages we use don't cover (subscription details, our own permissions).
   * Errors are thrown with Azure's error code attached, so the error rules
   * in azure/errors.ts can explain them.
   */
  private async armGet(path: string): Promise<any> {
    const token = await this.credential.getToken(ARM_SCOPE);
    const res = await fetch(`${ARM}${path}`, { headers: { Authorization: `Bearer ${token.token}` } });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err: any = new Error(body?.error?.message || `Azure returned HTTP ${res.status} for ${path}`);
      err.code = body?.error?.code || `HTTP_${res.status}`;
      err.statusCode = res.status;
      throw err;
    }
    return body;
  }

  /**
   * New subscriptions must "register" a service (resource provider) before
   * first use. Contributor is allowed to do that, so we just do it — once.
   */
  private async ensureProviderRegistered(namespace: string): Promise<void> {
    const provider = await this.resources.providers.get(namespace);
    if (provider.registrationState === 'Registered') return;
    await this.report('info', `Your subscription hasn't used ${namespace} before — registering it (one-time, 1–5 minutes)…`);
    await this.resources.providers.register(namespace);
    const started = Date.now();
    while (Date.now() - started < 5 * 60 * 1000) {
      await sleep(10_000);
      const p = await this.resources.providers.get(namespace);
      if (p.registrationState === 'Registered') {
        await this.report('success', `${namespace} is registered.`);
        return;
      }
    }
    await this.report('warn', `${namespace} is still registering — carrying on; if the next step fails, wait a few minutes and try again.`);
  }

  /** Make sure our resource group for this location exists. */
  private async ensureResourceGroup(location: string): Promise<string> {
    const rg = resourceGroupFor(location);
    const exists = await this.resources.resourceGroups.checkExistence(rg);
    if (exists.body) {
      await this.report('info', `Resource group "${rg}" already exists.`);
      return rg;
    }
    await this.report('info', `Creating resource group "${rg}" (a folder that will hold everything for your machines in ${location})…`);
    await this.resources.resourceGroups.createOrUpdate(rg, { location, tags: TAGS });
    await this.report('success', `Resource group "${rg}" created.`);
    return rg;
  }

  /**
   * Make sure the shared network pieces exist in this location:
   *   - a virtual network (a private network our machines sit on), with one subnet
   *   - the network security group (firewall) that opens the streaming ports
   * Created once per location and reused by every machine there.
   */
  private async ensureNetwork(rg: string, location: string): Promise<{ subnetId: string; nsgId: string }> {
    // Firewall (NSG)
    let nsgId: string | undefined;
    const ruleFor = (p: (typeof SUNSHINE_PORT_RANGES)[number], i: number) => ({
      name: `sunshine-${p.protocol}-${p.from}${p.to !== p.from ? `-${p.to}` : ''}`,
      description: 'Gints Global Gaming Hubjob: Sunshine/Moonlight streaming',
      priority: 1000 + i * 10,   // lower number = checked first; any value 100–4096 works
      direction: 'Inbound' as const,
      access: 'Allow' as const,
      protocol: p.protocol === 'tcp' ? 'Tcp' as const : 'Udp' as const,
      sourceAddressPrefix: 'Internet',
      sourcePortRange: '*',
      destinationAddressPrefix: '*',
      destinationPortRange: p.from === p.to ? String(p.from) : `${p.from}-${p.to}`,
    });
    try {
      const nsg = await this.network.networkSecurityGroups.get(rg, NSG_NAME);
      nsgId = nsg.id;
      // Created before newer ports (e.g. browser access) were added? Add their rules.
      const names = new Set((nsg.securityRules || []).map((r) => r.name));
      const wanted = SUNSHINE_PORT_RANGES.map(ruleFor).filter((r) => !names.has(r.name));
      for (const r of wanted) {
        await this.report('info', `Opening ${r.protocol.toUpperCase()} ${r.destinationPortRange} in firewall "${NSG_NAME}"…`);
        const { name, ...rule } = r;
        await this.network.securityRules.beginCreateOrUpdateAndWait(rg, NSG_NAME, name, rule);
      }
      await this.report('info', `Firewall "${NSG_NAME}" already exists — streaming ports are open.`);
    } catch (error) {
      if (!isAzureNotFound(error)) throw error;
    }
    if (!nsgId) {
      await this.report('info', `Creating firewall "${NSG_NAME}" that opens ONLY the streaming ports (no SSH, no remote desktop)…`,
        SUNSHINE_PORT_RANGES.map((p) => `${p.protocol.toUpperCase()} ${p.from === p.to ? p.from : `${p.from}-${p.to}`}`).join(' · '));
      const nsg = await this.network.networkSecurityGroups.beginCreateOrUpdateAndWait(rg, NSG_NAME, {
        location,
        tags: TAGS,
        securityRules: SUNSHINE_PORT_RANGES.map(ruleFor),
      });
      nsgId = nsg.id;
      await this.report('success', 'Firewall created.');
    }

    // Virtual network + subnet
    let subnetId: string | undefined;
    try {
      subnetId = (await this.network.subnets.get(rg, VNET_NAME, SUBNET_NAME)).id;
    } catch (error) {
      if (!isAzureNotFound(error)) throw error;
    }
    if (!subnetId) {
      await this.report('info', `Creating virtual network "${VNET_NAME}" (a private network for your machines)…`);
      await this.network.virtualNetworks.beginCreateOrUpdateAndWait(rg, VNET_NAME, {
        location,
        tags: TAGS,
        addressSpace: { addressPrefixes: ['10.40.0.0/16'] },
        subnets: [{ name: SUBNET_NAME, addressPrefix: '10.40.0.0/24' }],
      });
      subnetId = (await this.network.subnets.get(rg, VNET_NAME, SUBNET_NAME)).id;
      await this.report('success', 'Virtual network created.');
    }
    if (!subnetId || !nsgId) throw new Error('Azure did not return ids for the network or firewall it just created.');
    return { subnetId, nsgId };
  }

  /** The public IP of a VM, found by following VM → network card → public IP. */
  private async publicIpOf(vm: VirtualMachine): Promise<string> {
    const nicRef = parseArmId(vm.networkProfile?.networkInterfaces?.[0]?.id);
    if (!nicRef) return '';
    const nic = await this.network.networkInterfaces.get(nicRef.rg, nicRef.name);
    const ipRef = parseArmId(nic.ipConfigurations?.[0]?.publicIPAddress?.id);
    if (!ipRef) return '';
    const ip = await this.network.publicIPAddresses.get(ipRef.rg, ipRef.name);
    return ip.ipAddress || '';
  }

  /**
   * Delete a machine's parts, ignoring ones that are already gone. Used by
   * terminate, and to clean up after a launch that failed half-way.
   * Order matters: the VM must go before its network card, and the network
   * card before its public IP.
   */
  private async deleteMachineParts(rg: string, vmName: string, parts: { nic?: string; ip?: string; disk?: string; ipRg?: string; nicRg?: string; diskRg?: string }): Promise<string[]> {
    const problems: string[] = [];
    const attempt = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (error) {
        if (!isAzureNotFound(error)) problems.push(`${label}: ${(error as Error).message}`);
      }
    };
    await attempt(`VM ${vmName}`, () => this.compute.virtualMachines.beginDeleteAndWait(rg, vmName));
    if (parts.nic) await attempt(`network card ${parts.nic}`, () => this.network.networkInterfaces.beginDeleteAndWait(parts.nicRg || rg, parts.nic!));
    if (parts.ip) await attempt(`public IP ${parts.ip}`, () => this.network.publicIPAddresses.beginDeleteAndWait(parts.ipRg || rg, parts.ip!));
    if (parts.disk) await attempt(`disk ${parts.disk}`, () => this.compute.disks.beginDeleteAndWait(parts.diskRg || rg, parts.disk!));
    return problems;
  }

  /**
   * Create one machine. Shared by launchInstance (fresh Ubuntu disk) and
   * restoreFromSnapshot (disk copied from a snapshot).
   */
  private async createMachine(
    config: ProviderConfig,
    options: {
      spot: boolean;
      diskSizeGb: number;
      sunshineUsername: string;
      sunshinePassword: string;
      autoStopMinutes?: number;
      fromSnapshot?: Snapshot;
    }
  ): Promise<{ instanceId: string; ipAddress: string; costPerHour: number }> {
    const shape = findShape(config.instanceType);
    if (!shape) {
      throw new FriendlyCloudError({
        code: 'UNKNOWN_SHAPE',
        title: `Unknown machine type "${config.instanceType}"`,
        explanation: 'This machine size isn\'t one Gints Global Gaming Hubjob knows how to launch on Azure.',
        fixes: [`Choose one of: ${AZURE_SHAPES.map((s) => `${s.label} (${s.id})`).join(', ')}.`],
      });
    }
    const region = findRegion(config.region);
    if (!region) {
      throw new FriendlyCloudError({
        code: 'UNKNOWN_REGION',
        title: `Unsupported Azure location "${config.region}"`,
        explanation: 'We only launch in Azure locations that offer NVIDIA T4 GPU machines.',
        fixes: [`Choose one of: ${AZURE_REGIONS.map((r) => `${r.name} (${r.id})`).join(', ')}.`],
      });
    }
    if (!region.gpus.includes(shape.gpuModel)) {
      throw new FriendlyCloudError({
        code: 'GPU_NOT_IN_REGION',
        title: `${shape.gpuModel} GPUs aren't offered in ${region.name}`,
        explanation: `Azure doesn't sell ${shape.gpuModel} machines in ${region.id}.`,
        fixes: ['Pick another region.'],
      });
    }
    const location = region.id;

    await this.report('info', `Subscription ${this.subscriptionId} · ${shape.label} (${shape.id}) · ${region.name} (${location})` +
      `${options.spot ? ' · SPOT (cheaper, but Azure can stop it at any time if it needs the hardware back)' : ''}`);

    // Shared, reusable pieces (created only the first time).
    await this.ensureProviderRegistered('Microsoft.Compute');
    await this.ensureProviderRegistered('Microsoft.Network');
    const rg = await this.ensureResourceGroup(location);
    const { subnetId, nsgId } = await this.ensureNetwork(rg, location);

    // This machine's own pieces. A unique name: letters, digits, hyphens.
    const vmName = `cg-${crypto.randomBytes(4).toString('hex')}`;
    const names = partNames(vmName);
    const tags = { ...TAGS, 'cloudgaming-machine': vmName, 'sunshine-user': options.sunshineUsername };

    try {
      // 1. Public IP. "Standard" SKU (Azure's only option for new IPs) must be
      //    "Static": the address stays the same across stop/start, which is
      //    handy — Moonlight keeps working without re-adding the machine.
      await this.report('info', `Reserving a public IP address "${names.ip}"…`);
      const ip = await this.network.publicIPAddresses.beginCreateOrUpdateAndWait(rg, names.ip, {
        location,
        tags,
        sku: { name: 'Standard', tier: 'Regional' },
        publicIPAllocationMethod: 'Static',
        publicIPAddressVersion: 'IPv4',
      });
      await this.report('success', `Public IP reserved: ${ip.ipAddress || '(assigned shortly)'}.`);

      // 2. Network card, plugged into our subnet, behind our firewall, with that IP.
      await this.report('info', `Creating the network card "${names.nic}" (behind firewall "${NSG_NAME}")…`);
      const nic = await this.network.networkInterfaces.beginCreateOrUpdateAndWait(rg, names.nic, {
        location,
        tags,
        networkSecurityGroup: { id: nsgId },
        ipConfigurations: [
          {
            name: 'ipconfig1',
            privateIPAllocationMethod: 'Dynamic',
            subnet: { id: subnetId },
            publicIPAddress: { id: ip.id, deleteOption: 'Delete' },
          },
        ],
      });
      await this.report('success', 'Network card created.');

      // 3. (Restore only) a new disk copied from the snapshot.
      let attachDiskId: string | undefined;
      if (options.fromSnapshot) {
        await this.report('info', `Creating disk "${names.disk}" from the snapshot (usually under a minute)…`);
        const disk = await this.compute.disks.beginCreateOrUpdateAndWait(rg, names.disk, {
          location,
          tags,
          sku: { name: OS_DISK_SKU },
          osType: 'Linux',
          hyperVGeneration: options.fromSnapshot.hyperVGeneration || 'V2',
          creationData: { createOption: 'Copy', sourceResourceId: options.fromSnapshot.id },
        });
        attachDiskId = disk.id;
        await this.report('success', `Disk created (${disk.diskSizeGB ?? '?'} GB).`);
      }

      // 4. The VM itself.
      const vm: VirtualMachine = {
        location,
        tags,
        hardwareProfile: { vmSize: shape.id },
        storageProfile: attachDiskId
          ? {
              // Restored machine: boot from the copied disk as-is. Its setup
              // script is already installed on it, so no custom data is needed.
              osDisk: { osType: 'Linux', createOption: 'Attach', managedDisk: { id: attachDiskId }, deleteOption: 'Delete' },
            }
          : {
              imageReference: UBUNTU_IMAGE,
              osDisk: {
                name: names.disk,
                createOption: 'FromImage',
                diskSizeGB: options.diskSizeGb,
                caching: 'ReadWrite',
                managedDisk: { storageAccountType: OS_DISK_SKU },
                deleteOption: 'Delete',   // deleting the VM deletes its disk too
              },
            },
        osProfile: attachDiskId
          ? undefined // Azure forbids an osProfile when attaching an existing OS disk
          : {
              computerName: vmName,
              adminUsername: ADMIN_USER,
              // The setup script, base64-encoded. cloud-init runs it on first boot.
              customData: Buffer.from(azureSetupScript(options.sunshineUsername, options.sunshinePassword, options.autoStopMinutes)).toString('base64'),
              linuxConfiguration: {
                disablePasswordAuthentication: true,
                ssh: { publicKeys: [{ path: `/home/${ADMIN_USER}/.ssh/authorized_keys`, keyData: throwawaySshPublicKey() }] },
              },
            },
        networkProfile: { networkInterfaces: [{ id: nic.id, primary: true, deleteOption: 'Delete' }] },
        // Boot diagnostics with Azure-MANAGED storage (no storage account to
        // create): lets us read the serial console log to show setup progress.
        diagnosticsProfile: { bootDiagnostics: { enabled: true } },
        // SECURE BOOT MUST BE OFF. Ubuntu gen2 images can default to
        // "Trusted Launch" with Secure Boot ON, and Secure Boot refuses to
        // load kernel modules that aren't signed by a trusted key — which
        // includes the NVIDIA driver our setup script builds (DKMS). The GPU
        // would then be invisible. See SECURITY_PROFILES for what we try.
        securityProfile: SECURITY_PROFILES[0].profile,
        ...(options.spot
          ? {
              priority: 'Spot',
              evictionPolicy: 'Deallocate',     // if Azure needs the hardware back: stop, keep the disk
              billingProfile: { maxPrice: -1 }, // -1 = pay up to the normal price; never evicted for price
            }
          : {}),
      };

      await this.report('info', `Asking Azure to create the machine "${vmName}" — this usually takes 1–4 minutes…`);
      let created: VirtualMachine | undefined;
      for (let i = 0; i < SECURITY_PROFILES.length && !created; i++) {
        try {
          created = await this.compute.virtualMachines.beginCreateOrUpdateAndWait(rg, vmName, { ...vm, securityProfile: SECURITY_PROFILES[i].profile });
        } catch (error) {
          const last = i === SECURITY_PROFILES.length - 1;
          if (last || !isSecurityTypeRejection(error)) throw error;
          await this.report('warn', `Azure didn't accept "${SECURITY_PROFILES[i].label}" security for this machine — retrying with "${SECURITY_PROFILES[i + 1].label}" (Secure Boot stays off either way).`,
            (error as Error).message);
        }
      }
      if (!created) throw new Error('Azure did not return the machine it created.');
      const ipAddress = ip.ipAddress || (await this.publicIpOf(created).catch(() => ''));
      await this.report('success', `Machine ${vmName} created in ${location}${ipAddress ? ` with public IP ${ipAddress}` : ''}. ` +
        (attachDiskId ? 'It boots from your snapshot.' : 'It now installs the GPU driver, Sunshine and Steam by itself (about 10–20 minutes).'));

      return {
        instanceId: `${rg}/${vmName}`,
        ipAddress,
        costPerHour: estimateHourly(shape.id, location, options.spot),
      };
    } catch (error) {
      // Don't leave half a machine behind (a public IP and disk cost money).
      await this.report('warn', `Creating the machine failed — removing the parts already created for ${vmName} so they don't cost anything…`,
        (error as Error).message);
      const problems = await this.deleteMachineParts(rg, vmName, names);
      if (problems.length) {
        await this.report('warn', `Some parts couldn't be removed — delete them in the Azure portal (resource group ${rg}, names starting with ${vmName}).`, problems.join(' | '));
      } else {
        await this.report('info', 'Clean-up done. The shared network and firewall are kept for next time (they cost nothing).');
      }
      throw error;
    }
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
    const { rg, name } = this.splitId(instanceId);
    await this.report('info', `Asking Azure to stop AND deallocate ${name}. (On Azure, a machine that's merely "stopped" is still billed — ` +
      'deallocating gives the hardware back so compute billing stops. The disk and IP address are kept.) Takes 1–3 minutes…');
    await this.compute.virtualMachines.beginDeallocateAndWait(rg, name);
    await this.report('success', `${name} is stopped (deallocated). You now pay only for its disk and IP address.`);
  }

  async startInstance(instanceId: string): Promise<void> {
    const { rg, name } = this.splitId(instanceId);
    await this.report('info', `Asking Azure to start ${name} (1–3 minutes; Azure has to find a free GPU server again)…`);
    await this.compute.virtualMachines.beginStartAndWait(rg, name);
    await this.report('success', `${name} is running. Its public IP address is static, so it hasn't changed.`);
  }

  async terminateInstance(instanceId: string): Promise<void> {
    const { rg, name } = this.splitId(instanceId);

    // Find the machine's real parts first (restored machines, or ones
    // changed in the portal, may not follow our naming).
    let parts: { nic?: string; ip?: string; disk?: string; nicRg?: string; ipRg?: string; diskRg?: string } = partNames(name);
    try {
      const vm = await this.compute.virtualMachines.get(rg, name);
      const nicRef = parseArmId(vm.networkProfile?.networkInterfaces?.[0]?.id);
      const diskRef = parseArmId(vm.storageProfile?.osDisk?.managedDisk?.id);
      let ipRef: { rg: string; name: string } | undefined;
      if (nicRef) {
        const nic = await this.network.networkInterfaces.get(nicRef.rg, nicRef.name).catch(() => undefined);
        ipRef = parseArmId(nic?.ipConfigurations?.[0]?.publicIPAddress?.id);
      }
      parts = {
        nic: nicRef?.name ?? parts.nic, nicRg: nicRef?.rg,
        ip: ipRef?.name ?? parts.ip, ipRg: ipRef?.rg,
        disk: diskRef?.name ?? parts.disk, diskRg: diskRef?.rg,
      };
    } catch (error) {
      if (!isAzureNotFound(error)) throw error;
      await this.report('warn', `${name} was already gone at Azure (deleted in the portal?). Removing any leftover parts and cleaning up our record.`);
      await this.deleteMachineParts(rg, name, parts);
      return;
    }

    await this.report('info', `Asking Azure to delete ${name}, its disk, network card and public IP (1–3 minutes)…`);
    const problems = await this.deleteMachineParts(rg, name, parts);
    if (problems.length) {
      await this.report('warn', `The machine is deleted, but some of its parts couldn't be removed. Delete them in the Azure portal (resource group ${rg}).`, problems.join(' | '));
      if (problems.some((p) => p.startsWith(`VM ${name}`))) throw new Error(problems.join(' | '));
      return;
    }
    await this.report('success', `${name} deleted — it no longer costs anything.`);
  }

  async getInstanceStatus(instanceId: string): Promise<{
    status: 'starting' | 'running' | 'stopping' | 'stopped' | 'terminated' | 'unknown';
    ipAddress?: string;
  }> {
    const { rg, name } = this.splitId(instanceId);
    let vm: VirtualMachine;
    try {
      // 'instanceView' adds the live power state to the answer.
      vm = await this.compute.virtualMachines.get(rg, name, { expand: 'instanceView' });
    } catch (error) {
      if (isAzureNotFound(error)) return { status: 'terminated' };
      throw error;
    }

    // Azure reports codes like "PowerState/running" and "ProvisioningState/succeeded".
    const codes = (vm.instanceView?.statuses || []).map((s) => String(s.code || '').toLowerCase());
    const power = codes.find((c) => c.startsWith('powerstate/'))?.split('/')[1];
    const provisioning = codes.find((c) => c.startsWith('provisioningstate/'))?.split('/')[1];
    const map: Record<string, 'starting' | 'running' | 'stopping' | 'stopped'> = {
      starting: 'starting',
      running: 'running',
      stopping: 'stopping',
      deallocating: 'stopping',
      stopped: 'stopped',      // powered off but NOT deallocated (still billed) — deallocated automatically below
      deallocated: 'stopped',  // also what a spot eviction leaves behind
    };
    let status: 'starting' | 'running' | 'stopping' | 'stopped' | 'unknown' = (power && map[power]) || 'unknown';
    if (!power) {
      if (provisioning === 'creating' || provisioning === 'updating') status = 'starting';
      else if (provisioning === 'deleting') status = 'stopping';
    }

    // A VM shut down from INSIDE (our auto-stop, or "shutdown" in the OS)
    // ends up "stopped" but still ALLOCATED — and Azure keeps billing it.
    // Whenever we see that state, ask Azure to deallocate it (no waiting:
    // it takes a minute or two). The reconcile job checks every 5 minutes,
    // so an auto-stopped machine stops billing shortly after.
    if (power === 'stopped') {
      await this.report('warn', `${name} was shut down from inside the machine but is still allocated (and billed) — deallocating it now.`);
      this.compute.virtualMachines.beginDeallocate(rg, name)
        .then(() => console.log(`[Azure] Deallocating ${rg}/${name} after an in-guest shutdown`))
        .catch((error: unknown) => console.error(`[Azure] Couldn't deallocate ${rg}/${name}:`, (error as Error).message));
      status = 'stopping';
    }

    const ipAddress = await this.publicIpOf(vm).catch(() => '');
    return { status, ipAddress: ipAddress || undefined };
  }

  /**
   * Actual charges from Azure Cost Management (the Contributor role can read
   * them), daily per resource group, in the subscription's billing
   * currency. "This app" = resource groups named cloudgaming-hub-<region>.
   */
  async getBillingActuals(from: string, to: string): Promise<BillingActuals> {
    const token = await this.credential.getToken('https://management.azure.com/.default');
    const url = `https://management.azure.com/subscriptions/${this.subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;
    const lastDay = new Date(Date.parse(to + 'T00:00:00Z') - 1000).toISOString().slice(0, 19) + 'Z';
    const body = {
      type: 'ActualCost',
      timeframe: 'Custom',
      timePeriod: { from: `${from}T00:00:00Z`, to: lastDay },
      dataset: {
        granularity: 'Daily',
        aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
        grouping: [{ type: 'Dimension', name: 'ResourceGroupName' }],
      },
    };
    const rows: any[][] = [];
    let columns: string[] = [];
    let next: string | null = url;
    for (let page = 0; next && page < 20; page++) {
      const res: Response = await fetch(next, { method: 'POST', headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = String(json?.error?.message || res.statusText);
        if (res.status === 401 || res.status === 403) {
          throw new FriendlyCloudError({
            code: 'BILLING_PERMISSION', title: 'Your Azure key can\'t read cost data',
            explanation: `Azure answered: ${msg}`,
            fixes: [
              'Give the app\'s identity the "Cost Management Reader" role on the subscription:',
              `az role assignment create --assignee <CLIENT_ID> --role "Cost Management Reader" --scope /subscriptions/${this.subscriptionId}`,
              'Free-trial, student and sponsorship subscriptions don\'t offer cost data through the API; Pay-As-You-Go does.',
            ],
            consoleUrl: 'https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis', consoleLabel: 'Open Cost analysis',
          });
        }
        if (res.status === 429) {
          throw new FriendlyCloudError({ code: 'BILLING_RATE_LIMITED', title: 'Azure asked us to slow down', explanation: msg, fixes: ['Try again in a few minutes.'] });
        }
        throw new FriendlyCloudError({ code: 'BILLING_ERROR', title: 'Azure couldn\'t return cost data', explanation: msg, fixes: ['Try again later.'] });
      }
      columns = (json.properties?.columns || []).map((c: any) => String(c.name));
      rows.push(...(json.properties?.rows || []));
      next = json.properties?.nextLink || null;
    }
    const col = (name: string) => columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
    const [iCost, iDate, iRg, iCur] = [col('Cost'), col('UsageDate'), col('ResourceGroupName'), col('Currency')];
    const app = new Map<string, number>();
    const account = new Map<string, number>();
    let currency = 'USD';
    for (const r of rows) {
      const d = String(r[iDate]);                       // e.g. 20260927
      const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      const amount = Number(r[iCost]) || 0;
      if (iCur >= 0 && r[iCur]) currency = String(r[iCur]);
      account.set(date, (account.get(date) || 0) + amount);
      if (String(r[iRg] || '').toLowerCase().startsWith(RG_PREFIX)) app.set(date, (app.get(date) || 0) + amount);
    }
    const toDays = (m: Map<string, number>) => [...m.entries()].sort().map(([date, amount]) => ({ date, amount }));
    return {
      currency, scope: 'app', scopeNote: `Resource groups ${RG_PREFIX}*`,
      daily: toDays(app), accountDaily: toDays(account),
    };
  }

  async createSnapshot(instanceId: string, _diskPath: string): Promise<{ snapshotId: string; sizeGb: number }> {
    // Our machines have one disk (the OS disk, with the games on it); we snapshot it whole.
    const { rg, name } = this.splitId(instanceId);
    const vm = await this.compute.virtualMachines.get(rg, name, { expand: 'instanceView' });
    const diskId = vm.storageProfile?.osDisk?.managedDisk?.id;
    if (!diskId || !vm.location) throw new Error(`Couldn't find the disk of ${name} at Azure.`);
    const running = (vm.instanceView?.statuses || []).some((s) => String(s.code).toLowerCase() === 'powerstate/running');
    if (running) {
      await this.report('warn', `${name} is running. The snapshot will work, but it's like pulling the power plug mid-game — stopping the machine first is safest.`);
    }

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // e.g. 20260927143005
    const snapshotName = `${name}-snap-${stamp}`;
    await this.report('info', `Snapshotting the disk of ${name} (games and settings included)… The first snapshot copies the whole disk; later ones only store changes.`);
    const snap = await this.compute.snapshots.beginCreateOrUpdateAndWait(rg, snapshotName, {
      location: vm.location,
      tags: { ...TAGS, 'cloudgaming-machine': name },
      sku: { name: 'Standard_LRS' },
      // "Incremental" snapshots store only what changed since the previous
      // one — cheaper — and are the only kind Azure can copy to another region.
      incremental: true,
      creationData: { createOption: 'Copy', sourceResourceId: diskId },
    });
    await this.report('success', `Snapshot ${snapshotName} created.`);
    return { snapshotId: `${rg}/${snapshotName}`, sizeGb: Number(snap.diskSizeGB) || Number(vm.storageProfile?.osDisk?.diskSizeGB) || 0 };
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotInfo> {
    const { rg, name } = this.splitId(snapshotId);
    const snap = await this.compute.snapshots.get(rg, name);
    const provisioning = String(snap.provisioningState || '');
    // completionPercent is set while a region-to-region copy (CopyStart) is still running.
    const copying = snap.completionPercent !== undefined && snap.completionPercent !== null && snap.completionPercent < 100;
    return {
      id: snapshotId,
      sizeGb: Number(snap.diskSizeGB) || 0,
      state: provisioning === 'Failed' ? 'failed' : provisioning === 'Succeeded' && !copying ? 'completed' : 'pending',
    };
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    const { rg, name } = this.splitId(snapshotId);
    await this.report('info', `Deleting snapshot ${name}…`);
    try {
      await this.compute.snapshots.beginDeleteAndWait(rg, name);
    } catch (error) {
      if (!isAzureNotFound(error)) throw error;
      await this.report('warn', `Snapshot ${name} was already gone at Azure.`);
      return;
    }
    await this.report('success', `Snapshot ${name} deleted.`);
  }

  async restoreFromSnapshot(snapshotId: string, config: ProviderConfig, opts: RestoreOptions = {}): Promise<{ instanceId: string; ipAddress: string }> {
    const { rg, name } = this.splitId(snapshotId);
    const snap = await this.compute.snapshots.get(rg, name);
    const snapLocation = String(snap.location || '').toLowerCase();
    const target = String(config.region || snapLocation).toLowerCase();
    if (target !== snapLocation) {
      throw new FriendlyCloudError({
        code: 'AZURE_SNAPSHOT_OTHER_REGION',
        title: `This snapshot is in ${snapLocation}, not ${target}`,
        explanation: 'On Azure, a machine can only be created from a snapshot stored in the same location.',
        fixes: [
          `Restore it in ${snapLocation} instead, or`,
          `copy (replicate) the snapshot to ${target} first, wait until the copy shows as completed, then restore that copy.`,
        ],
      });
    }
    const info = await this.getSnapshot(snapshotId);
    if (info.state !== 'completed') {
      throw new FriendlyCloudError({
        code: 'AZURE_SNAPSHOT_NOT_READY',
        title: 'This snapshot isn\'t ready yet',
        explanation: 'Azure is still creating or copying it.',
        fixes: ['Wait a few minutes and try again.'],
      });
    }
    await this.report('info', `Creating a new machine from snapshot ${name}. It keeps the games, settings and Sunshine login of the original machine.`);
    const { instanceId, ipAddress } = await this.createMachine({ ...config, region: snapLocation }, {
      spot: !!opts.spot,
      diskSizeGb: Number(snap.diskSizeGB) || 150,
      sunshineUsername: 'gamer',
      sunshinePassword: crypto.randomBytes(12).toString('base64url'), // unused: the restored disk keeps its own login
      fromSnapshot: snap,
    });
    return { instanceId, ipAddress };
  }

  async replicateSnapshot(
    sourceSnapshotId: string,
    sourceProvider: string,
    _sourceRegion: string,
    targetRegion: string
  ): Promise<{ snapshotId: string }> {
    if (sourceProvider !== 'azure') {
      throw new FriendlyCloudError({
        code: 'CROSS_CLOUD_UNSUPPORTED',
        title: 'Copying snapshots from another cloud into Azure isn\'t supported yet',
        explanation: 'Each cloud stores disks in its own format; converting between them isn\'t built yet.',
        fixes: ['Launch a fresh machine on Azure instead.'],
      });
    }
    const { rg, name } = this.splitId(sourceSnapshotId);
    const source = await this.compute.snapshots.get(rg, name);
    const target = String(targetRegion || '').toLowerCase();
    if (!target || target === String(source.location).toLowerCase()) return { snapshotId: sourceSnapshotId };
    if (!findRegion(target)) {
      throw new FriendlyCloudError({
        code: 'UNKNOWN_REGION',
        title: `Unsupported Azure location "${targetRegion}"`,
        explanation: 'We only copy snapshots to locations where we can launch machines.',
        fixes: [`Choose one of: ${AZURE_REGIONS.map((r) => `${r.name} (${r.id})`).join(', ')}.`],
      });
    }
    if (!source.incremental) {
      throw new FriendlyCloudError({
        code: 'AZURE_SNAPSHOT_NOT_COPYABLE',
        title: 'This snapshot can\'t be copied to another region',
        explanation: 'Azure can only copy "incremental" snapshots between regions, and this one is a full snapshot (probably made outside this app).',
        fixes: ['Take a new snapshot of the machine from this app, then copy that one.'],
      });
    }

    const targetRg = await this.ensureResourceGroup(target);
    const copyName = `${name}-${target}`.slice(0, 80);
    await this.report('info', `Starting a copy of snapshot ${name} from ${source.location} to ${target}. ` +
      'Azure copies it in the background — this can take from minutes to a few hours for large disks.');
    try {
      await this.compute.snapshots.beginCreateOrUpdateAndWait(targetRg, copyName, {
        location: target,
        tags: { ...TAGS, 'copied-from': sourceSnapshotId },
        sku: { name: 'Standard_LRS' },
        incremental: true,
        creationData: { createOption: 'CopyStart', sourceResourceId: source.id },
      });
    } catch (error) {
      if (/CopyStart|not supported|NotSupported/i.test((error as Error).message)) {
        throw new FriendlyCloudError({
          code: 'AZURE_SNAPSHOT_COPY_UNSUPPORTED',
          title: `Azure can't copy this snapshot to ${target}`,
          explanation: 'Azure refused the cross-region copy (not every region pair or disk type supports it).',
          fixes: ['Launch a fresh machine in the new region instead, or restore the snapshot in its original region.'],
          raw: (error as Error).message,
        });
      }
      throw error;
    }
    await this.report('success', `Copy started: ${copyName}. It shows as "pending" until Azure finishes copying.`);
    return { snapshotId: `${targetRg}/${copyName}` };
  }

  async getRegions(): Promise<RegionData[]> {
    const cheapest = AZURE_SHAPES[0].id;
    return AZURE_REGIONS.map((r) => ({
      provider: 'azure',
      name: r.name,
      region: r.id,
      lat: r.lat,
      lng: r.lng,
      onDemandPrice: estimateHourly(cheapest, r.id),
      spotPrice: estimateHourly(cheapest, r.id, true),
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
      code: 'AZURE_COSTS_UNAVAILABLE',
      title: 'Actual Azure spend isn\'t available yet',
      explanation:
        'Real spend comes from Azure\'s Cost Management API, which isn\'t connected yet. Costs shown here are estimates from running time.',
      fixes: ['See exact spend in the Azure portal under Cost Management → Cost analysis (filter by tag app = cloudgaming-hub).'],
      consoleUrl: 'https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis',
      consoleLabel: 'Open Cost analysis',
    });
  }

  async validateCredentials(): Promise<boolean> {
    try {
      // Listing resource groups needs a working login AND access to the subscription.
      await this.listResourceGroupNames(1);
      return true;
    } catch (error) {
      console.error('[Azure] credential check failed:', (error as Error).message);
      return false;
    }
  }

  // ==========================================================================
  // Inventory (the infrastructure map)
  // ==========================================================================

  /**
   * Everything we've created in this subscription, for the infrastructure
   * map. We find our resource groups ("cloudgaming-hub-<location>", or any
   * group tagged app=cloudgaming-hub) and list what's inside each one — all
   * groups in parallel, and within a group all resource kinds in parallel:
   *   - the resource group itself, the virtual network and the firewall (NSG)
   *     — free;
   *   - virtual machines, with their live power state and ≈ hourly price;
   *   - managed disks (≈ monthly, billed even while the VM is deallocated);
   *   - snapshots (≈ monthly);
   *   - public IP addresses (a static IP ≈ $3.65/month, even when unused);
   *   - network cards (free, but a leftover one is clutter).
   *
   * "ORPHANS" are leftovers not attached to any machine: a disk whose VM is
   * gone, a public IP not plugged into anything, a network card without a
   * VM, a snapshot whose original disk was deleted. They usually come from a
   * machine deleted in the portal, or a launch that failed half-way.
   *
   * Nothing found → []. Login/permission problems are thrown (the caller
   * explains them).
   */
  async listResources(): Promise<InventoryItem[]> {
    // 1. Our resource groups, plus the live power state of every VM in the
    //    subscription. "statusOnly" asks Azure for ONLY the power states, in
    //    one paged call, instead of one call per machine. If that fails
    //    (it's a nice-to-have) the VMs show as "unknown".
    const [groups, powerStates] = await Promise.all([
      collect(this.resources.resourceGroups.list()),
      collect(this.compute.virtualMachines.listAll({ statusOnly: 'true' }))
        .then((vms) => new Map(vms.map((vm) => [
          String(vm.id || '').toLowerCase(),
          (vm.instanceView?.statuses || []).map((st) => String(st.code || '').toLowerCase()),
        ])))
        .catch((error: unknown) => {
          console.error('[Azure] Couldn\'t read VM power states:', (error as Error).message);
          return new Map<string, string[]>();
        }),
    ]);
    const ours = groups.filter((g) =>
      String(g.name || '').toLowerCase().startsWith(RG_PREFIX) || g.tags?.[RESOURCE_TAG.key] === RESOURCE_TAG.value);
    if (!ours.length) return [];

    // 2. Everything inside each group, all at once. A group deleted while
    //    we're looking (404) just comes back empty.
    const perGroup = await Promise.all(ours.map(async (group) => {
      const rg = String(group.name);
      try {
        const [vms, disks, snapshots, ips, nics, vnets, nsgs] = await Promise.all([
          collect(this.compute.virtualMachines.list(rg)),
          collect(this.compute.disks.listByResourceGroup(rg)),
          collect(this.compute.snapshots.listByResourceGroup(rg)),
          collect(this.network.publicIPAddresses.list(rg)),
          collect(this.network.networkInterfaces.list(rg)),
          collect(this.network.virtualNetworks.list(rg)),
          collect(this.network.networkSecurityGroups.list(rg)),
        ]);
        return { group, rg, vms, disks, snapshots, ips, nics, vnets, nsgs };
      } catch (error) {
        if (isAzureNotFound(error)) return undefined;
        throw error;
      }
    }));
    const found = perGroup.filter((g): g is NonNullable<typeof g> => !!g);

    // 3. Lookup tables across ALL groups (a disk's VM, or a snapshot's disk,
    //    could in principle live in another of our groups).
    //    Azure ids are case-insensitive — and Azure sometimes returns the
    //    resource group in CAPITALS inside ids — so keys are lowercased.
    //    VM full id → our instance id "resourceGroup/vmName" (as stored in machines.instance_id).
    const vmInstanceIds = new Map<string, string>();
    for (const g of found) for (const vm of g.vms) vmInstanceIds.set(String(vm.id).toLowerCase(), `${g.rg}/${vm.name}`);
    const ourInstanceId = (vmId: string | undefined): string | undefined => {
      if (!vmId) return undefined;
      const known = vmInstanceIds.get(vmId.toLowerCase());
      if (known) return known;
      const ref = parseArmId(vmId); // a VM we didn't list (e.g. outside our groups)
      return ref ? `${ref.rg.toLowerCase()}/${ref.name}` : undefined;
    };
    //    NIC full id → the VM it's plugged into (our format), for public IPs.
    const nicToVm = new Map<string, string | undefined>();
    for (const g of found) for (const nic of g.nics) nicToVm.set(String(nic.id).toLowerCase(), ourInstanceId(nic.virtualMachine?.id));
    //    Every disk id we saw, and which groups we fully listed (for snapshot orphans).
    const diskIds = new Set<string>();
    for (const g of found) for (const d of g.disks) diskIds.add(String(d.id).toLowerCase());
    const listedGroups = new Set(found.map((g) => g.rg.toLowerCase()));

    // 4. Turn it all into map entries.
    const items: InventoryItem[] = [];
    const iso = (d: Date | undefined) => (d ? new Date(d).toISOString() : undefined);
    for (const g of found) {
      const groupRegion = String(g.group.location || '').toLowerCase() || 'global';
      const regionOf = (location: string | undefined) => String(location || '').toLowerCase() || groupRegion;

      // The resource group itself (free — just a folder).
      items.push({
        provider: 'azure', type: 'resource-group', id: String(g.group.id || g.rg), name: g.rg,
        region: groupRegion, status: 'active', consoleUrl: portalLink(g.group.id),
      });

      // Virtual machines.
      for (const vm of g.vms) {
        const location = regionOf(vm.location);
        const size = String(vm.hardwareProfile?.vmSize || '');
        const codes = powerStates.get(String(vm.id).toLowerCase()) || [];
        items.push({
          provider: 'azure', type: 'vm', id: String(vm.id), name: String(vm.name),
          region: location,
          zone: vm.zones?.[0],
          status: vmStatusWords(codes, vm.provisioningState),
          instanceId: `${g.rg}/${vm.name}`,
          hourlyCost: estimateHourly(size, location, vm.priority === 'Spot') || undefined,
          consoleUrl: portalLink(vm.id),
          createdAt: iso(vm.timeCreated),
        });
      }

      // Managed disks. "managedBy" is the full id of the VM using it, if any.
      for (const disk of g.disks) {
        const sizeGb = Number(disk.diskSizeGB) || 0;
        const attachedTo = ourInstanceId(disk.managedBy);
        const state = String(disk.diskState || '');
        const unattached = state === 'Unattached';
        items.push({
          provider: 'azure', type: 'disk', id: String(disk.id), name: String(disk.name),
          region: regionOf(disk.location),
          zone: disk.zones?.[0],
          status: state ? state.toLowerCase() : 'unknown',   // 'attached', 'unattached', 'reserved' (VM deallocated)…
          attachedTo,
          sizeGb: sizeGb || undefined,
          monthlyCost: estimateDiskMonthly(sizeGb, disk.sku?.name),
          orphan: unattached || undefined,
          orphanReason: unattached ? 'Disk not attached to any machine — still billed every month' : undefined,
          consoleUrl: portalLink(disk.id),
          createdAt: iso(disk.timeCreated),
        });
      }

      // Snapshots. Priced on their full size — an overestimate for
      // incremental snapshots, which only store the changed blocks.
      for (const snap of g.snapshots) {
        const sizeGb = Number(snap.diskSizeGB) || 0;
        // Orphan if it was taken from a disk in one of OUR groups and that
        // disk is gone. (Copies of snapshots, or disks elsewhere, can't be
        // checked cheaply — not flagged.)
        const source = String(snap.creationData?.sourceResourceId || '');
        const sourceRef = /\/providers\/Microsoft\.Compute\/disks\//i.test(source) ? parseArmId(source) : undefined;
        const sourceGone = !!sourceRef && listedGroups.has(sourceRef.rg.toLowerCase()) && !diskIds.has(source.toLowerCase());
        const provisioning = String(snap.provisioningState || '').toLowerCase();
        const copying = snap.completionPercent !== undefined && snap.completionPercent !== null && snap.completionPercent < 100;
        items.push({
          provider: 'azure', type: 'snapshot', id: String(snap.id), name: String(snap.name),
          region: regionOf(snap.location),
          status: provisioning === 'succeeded' ? (copying ? 'copying' : 'ready') : provisioning || 'unknown',
          sizeGb: sizeGb || undefined,
          monthlyCost: Math.round(sizeGb * SNAPSHOT_PER_GB_MONTH * 100) / 100,
          orphan: sourceGone || undefined,
          orphanReason: sourceGone ? `The disk it was taken from (${sourceRef!.name}) no longer exists` : undefined,
          consoleUrl: portalLink(snap.id),
          createdAt: iso(snap.timeCreated),
        });
      }

      // Public IP addresses. Static ones (all of ours) are billed whether or
      // not they're in use. "ipConfiguration" is set while one is plugged
      // into a network card (…/networkInterfaces/NIC/ipConfigurations/ipconfig1).
      for (const ip of g.ips) {
        const configId = String(ip.ipConfiguration?.id || '');
        const nicId = configId.toLowerCase().split('/ipconfigurations/')[0];
        const attachedTo = configId ? nicToVm.get(nicId) : undefined;
        const isStatic = ip.publicIPAllocationMethod === 'Static' || ip.sku?.name === 'Standard';
        const monthlyCost = isStatic || configId ? STATIC_IP_PER_MONTH : 0; // an unused dynamic (Basic) IP costs nothing
        const unused = !configId && monthlyCost > 0;
        items.push({
          provider: 'azure', type: 'public-ip', id: String(ip.id), name: `${ip.name}${ip.ipAddress ? ` (${ip.ipAddress})` : ''}`,
          region: regionOf(ip.location),
          zone: ip.zones?.length === 1 ? ip.zones[0] : undefined,
          status: configId ? 'in-use' : 'available',
          attachedTo,
          monthlyCost,
          orphan: unused || undefined,
          orphanReason: unused ? 'Public IP not attached to any machine — still billed (~USD 3.65/month)' : undefined,
          consoleUrl: portalLink(ip.id),
        });
      }

      // Network cards (free, but a leftover one is clutter — and can keep a
      // public IP "in use").
      for (const nic of g.nics) {
        const attachedTo = ourInstanceId(nic.virtualMachine?.id);
        items.push({
          provider: 'azure', type: 'nic', id: String(nic.id), name: String(nic.name),
          region: regionOf(nic.location),
          status: attachedTo ? 'in-use' : 'available',
          attachedTo,
          orphan: !attachedTo || undefined,
          orphanReason: attachedTo ? undefined : 'Network card not attached to any machine (free, but a leftover)',
          consoleUrl: portalLink(nic.id),
        });
      }

      // The shared virtual network and firewall for this location (free).
      for (const vnet of g.vnets) {
        items.push({
          provider: 'azure', type: 'network', id: String(vnet.id), name: String(vnet.name),
          region: regionOf(vnet.location), status: 'active', consoleUrl: portalLink(vnet.id),
        });
      }
      for (const nsg of g.nsgs) {
        items.push({
          provider: 'azure', type: 'firewall', id: String(nsg.id), name: String(nsg.name),
          region: regionOf(nsg.location), status: 'active', consoleUrl: portalLink(nsg.id),
        });
      }
    }
    return items;
  }

  // ==========================================================================
  // Azure-specific extras (used by the credential checks and machine pages)
  // ==========================================================================

  /** Get an access token — proves tenant, client ID and secret are right. Throws on failure. */
  async signIn(): Promise<void> {
    await this.credential.getToken(ARM_SCOPE);
  }

  /** The subscription's name, state and offer type. Throws on failure. */
  async getSubscription(): Promise<AzureSubscriptionInfo> {
    const sub = await this.armGet(`/subscriptions/${this.subscriptionId}?api-version=2022-12-01`);
    return {
      subscriptionId: sub.subscriptionId || this.subscriptionId,
      displayName: sub.displayName || '',
      state: sub.state || 'Unknown',
      quotaId: sub.subscriptionPolicies?.quotaId,
    };
  }

  /** Up to `max` resource group names (a cheap "can we read this subscription?" test). */
  async listResourceGroupNames(max = 5): Promise<string[]> {
    const names: string[] = [];
    for await (const group of this.resources.resourceGroups.list()) {
      names.push(String(group.name));
      if (names.length >= max) break;
    }
    return names;
  }

  /**
   * What this login is allowed to do on the subscription, as Azure lists it
   * (e.g. Contributor = actions ["*"] minus a few "notActions").
   */
  async getPermissions(): Promise<Array<{ actions: string[]; notActions: string[] }>> {
    const body = await this.armGet(`/subscriptions/${this.subscriptionId}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`);
    return (body.value || []).map((p: any) => ({ actions: p.actions || [], notActions: p.notActions || [] }));
  }

  /** 'Registered', 'NotRegistered', 'Registering'... for a resource provider. */
  async getProviderState(namespace: string): Promise<string> {
    return String((await this.resources.providers.get(namespace)).registrationState || 'Unknown');
  }

  /** Start registering a resource provider (finishes in the background). */
  async registerProvider(namespace: string): Promise<void> {
    await this.resources.providers.register(namespace);
  }

  /** Compute quotas in a location (vCPU counts), e.g. 'standardNCASv3_T4Family', 'cores', 'lowPriorityCores'. */
  async getComputeUsage(location: string): Promise<Array<{ name: string; label: string; limit: number; current: number }>> {
    const out: Array<{ name: string; label: string; limit: number; current: number }> = [];
    for await (const u of this.compute.usage.list(location)) {
      out.push({ name: String(u.name?.value || ''), label: String(u.name?.localizedValue || u.name?.value || ''), limit: Number(u.limit) || 0, current: Number(u.currentValue) || 0 });
    }
    return out;
  }

  /**
   * Read the machine's serial console log (via boot diagnostics) and extract
   * the setup stages printed by the setup script. Azure refreshes this log
   * every minute or so, so progress can lag a little. Returns [] if nothing
   * is available yet (or on any error — progress is a nice-to-have).
   */
  async getSetupProgress(instanceId: string): Promise<SetupStage[]> {
    try {
      const { rg, name } = this.splitId(instanceId);
      const diag = await this.compute.virtualMachines.retrieveBootDiagnosticsData(rg, name, { sasUriExpirationTimeInMinutes: 5 });
      if (!diag.serialConsoleLogBlobUri) return [];
      // The URI is a short-lived, pre-signed link to the log file: no login needed.
      const res = await fetch(diag.serialConsoleLogBlobUri);
      if (!res.ok) return [];
      return parseSetupStages(await res.text());
    } catch {
      return [];
    }
  }

  /** The machine's IP, power state and the Sunshine username (the password isn't stored at Azure). */
  async getConnectionInfo(instanceId: string): Promise<{ ipAddress: string; username?: string; status: string }> {
    const { rg, name } = this.splitId(instanceId);
    const vm = await this.compute.virtualMachines.get(rg, name);
    const { status } = await this.getInstanceStatus(instanceId);
    return { ipAddress: await this.publicIpOf(vm).catch(() => ''), username: vm.tags?.['sunshine-user'], status };
  }
}
