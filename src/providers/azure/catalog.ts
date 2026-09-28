/**
 * ============================================================================
 * src/providers/azure/catalog.ts — WHAT CAN BE LAUNCHED ON AZURE, AND ~COST
 * ============================================================================
 *
 * The launch form's choices come from here (via GET /api/machines/options):
 *   - REGIONS: Azure "locations" (Azure's word for region, e.g.
 *     'southeastasia') that offer NVIDIA T4 GPU machines, with approximate
 *     location (for "nearest to you") and price adjustments.
 *   - SHAPES:  the machine sizes ("VM sizes" in Azure-speak) we offer.
 *
 * WHICH GPU MACHINES, AND WHY ONLY T4
 * -----------------------------------
 * We offer the NCasT4_v3 family: each machine gets a WHOLE NVIDIA T4 GPU,
 * which works with the normal NVIDIA datacenter driver our setup script
 * installs (shared/setupScript.ts, "nvidia-driver-535-server").
 *
 * We deliberately DO NOT offer the NVadsA10_v5 family (NV6ads_A10_v5,
 * NV12ads_A10_v5, ...) even though it's popular for gaming. Those machines
 * get a SLICE of an A10 GPU (a "GPU partition"), and a slice only works with
 * Microsoft's special NVIDIA GRID driver — the normal driver can't use it.
 * The GRID driver is downloaded from Microsoft, not Ubuntu's package
 * repositories, and its version must match what Azure's hosts run. CloudyPad
 * (the project our setup is modelled on) excludes these sizes for the same
 * reason. Adding them later means teaching the setup script a GRID path.
 *
 * ABOUT THE PRICES
 * ----------------
 * ESTIMATES in US dollars per hour, from Azure's published East US
 * pay-as-you-go Linux prices, scaled by a rough per-region factor. Real
 * prices vary by region, change over time and exclude tax. Spot prices move
 * constantly; we assume ~30% of on-demand. The UI labels them "≈". For exact
 * numbers use https://azure.microsoft.com/pricing/calculator/.
 * ============================================================================
 */

import type { ProviderCatalog } from '../shared/types';

export interface AzureShape {
  id: string;               // our id AND Azure's VM size name, stored in machines.instance_type
  label: string;            // shown in the launch form
  gpuModel: 'T4';
  /** The per-region "family" quota (counted in vCPUs) this size uses, as Azure's usage API names it. */
  quotaFamily: string;
  vcpus: number;
  memoryGb: number;
  eastUsOnDemand: number;   // $/hour, East US, pay-as-you-go, Linux
  bestFor: string;
}

export const AZURE_SHAPES: AzureShape[] = [
  {
    id: 'Standard_NC4as_T4_v3',
    label: 'T4 · 4 vCPU · 28 GB RAM',
    gpuModel: 'T4',
    quotaFamily: 'standardNCASv3_T4Family',
    vcpus: 4,
    memoryGb: 28,
    eastUsOnDemand: 0.526,
    bestFor: 'Indie, esports and older AAA games at 1080p60. Cheapest Azure option.',
  },
  {
    id: 'Standard_NC8as_T4_v3',
    label: 'T4 · 8 vCPU · 56 GB RAM',
    gpuModel: 'T4',
    quotaFamily: 'standardNCASv3_T4Family',
    vcpus: 8,
    memoryGb: 56,
    eastUsOnDemand: 0.752,
    bestFor: 'CPU-heavy games (strategy, simulators) at 1080p60. Same GPU, twice the CPU.',
  },
];

/** The quota family our machines need (all current shapes share it). */
export const T4_QUOTA_FAMILY = 'standardNCASv3_T4Family';

export interface AzureRegion {
  id: string;               // Azure location name, e.g. 'southeastasia'
  name: string;
  lat: number;
  lng: number;
  gpus: Array<'T4'>;        // GPU models (among our shapes) Azure offers here — best knowledge
  priceFactor: number;      // multiplier vs East US (approximate)
  egressPerGb: number;      // $/GB to the internet (approximate; first 100 GB/month free)
}

/**
 * Egress ("bandwidth") prices: Azure charges by "zone" — North America and
 * Europe ≈ $0.087/GB, Asia/Australia/Japan/India ≈ $0.12/GB (the first
 * 100 GB each month are free on every account).
 */
export const AZURE_REGIONS: AzureRegion[] = [
  { id: 'southeastasia', name: 'Singapore', lat: 1.35, lng: 103.82, gpus: ['T4'], priceFactor: 1.25, egressPerGb: 0.12 },
  { id: 'australiaeast', name: 'Sydney', lat: -33.87, lng: 151.21, gpus: ['T4'], priceFactor: 1.4, egressPerGb: 0.12 },
  { id: 'japaneast', name: 'Tokyo', lat: 35.68, lng: 139.69, gpus: ['T4'], priceFactor: 1.4, egressPerGb: 0.12 },
  // Added after real quota approvals (NCASv3_T4 auto-approved = Azure has capacity there).
  // Price factors are rough; Recon/launch use Azure's live prices when reachable.
  { id: 'eastasia', name: 'Hong Kong (East Asia)', lat: 22.28, lng: 114.16, gpus: ['T4'], priceFactor: 1.3, egressPerGb: 0.12 },
  { id: 'japanwest', name: 'Osaka (Japan West)', lat: 34.69, lng: 135.5, gpus: ['T4'], priceFactor: 1.4, egressPerGb: 0.12 },
  { id: 'malaysiawest', name: 'Kuala Lumpur (Malaysia West)', lat: 3.14, lng: 101.69, gpus: ['T4'], priceFactor: 1.3, egressPerGb: 0.12 },
  { id: 'koreacentral', name: 'Seoul (Korea Central)', lat: 37.57, lng: 126.98, gpus: ['T4'], priceFactor: 1.3, egressPerGb: 0.12 },
  { id: 'southindia', name: 'Chennai (South India)', lat: 13.08, lng: 80.27, gpus: ['T4'], priceFactor: 1.05, egressPerGb: 0.12 },
  { id: 'westus', name: 'California (West US)', lat: 37.78, lng: -122.42, gpus: ['T4'], priceFactor: 1.1, egressPerGb: 0.087 },
  { id: 'centralindia', name: 'Pune (Central India)', lat: 18.52, lng: 73.86, gpus: ['T4'], priceFactor: 1.05, egressPerGb: 0.12 },
  { id: 'eastus', name: 'Virginia (East US)', lat: 37.37, lng: -79.82, gpus: ['T4'], priceFactor: 1.0, egressPerGb: 0.087 },
  { id: 'westus2', name: 'Washington (West US 2)', lat: 47.23, lng: -119.85, gpus: ['T4'], priceFactor: 1.0, egressPerGb: 0.087 },
  { id: 'westeurope', name: 'Netherlands (West Europe)', lat: 52.37, lng: 4.9, gpus: ['T4'], priceFactor: 1.1, egressPerGb: 0.087 },
  { id: 'uksouth', name: 'London (UK South)', lat: 51.51, lng: -0.13, gpus: ['T4'], priceFactor: 1.15, egressPerGb: 0.087 },
  // Every other public Azure region, 2026. Not all of them sell the T4 sizes
  // (or sell them to every subscription): the Regions page asks Azure live
  // (its SKU list) and shows "Not sold here" or the restriction, with the fix.
  { id: 'australiasoutheast', name: 'Melbourne (Australia Southeast)', lat: -37.81, lng: 144.96, gpus: ['T4'], priceFactor: 1.4, egressPerGb: 0.12 },
  { id: 'eastus2', name: 'Virginia (East US 2)', lat: 36.67, lng: -78.39, gpus: ['T4'], priceFactor: 1.0, egressPerGb: 0.087 },
  { id: 'southcentralus', name: 'Texas (South Central US)', lat: 29.42, lng: -98.49, gpus: ['T4'], priceFactor: 1.0, egressPerGb: 0.087 },
  { id: 'northcentralus', name: 'Chicago (North Central US)', lat: 41.88, lng: -87.63, gpus: ['T4'], priceFactor: 1.0, egressPerGb: 0.087 },
  { id: 'centralus', name: 'Iowa (Central US)', lat: 41.59, lng: -93.6, gpus: ['T4'], priceFactor: 1.0, egressPerGb: 0.087 },
  { id: 'westus3', name: 'Phoenix (West US 3)', lat: 33.45, lng: -112.07, gpus: ['T4'], priceFactor: 1.0, egressPerGb: 0.087 },
  { id: 'canadacentral', name: 'Toronto (Canada Central)', lat: 43.65, lng: -79.38, gpus: ['T4'], priceFactor: 1.1, egressPerGb: 0.087 },
  { id: 'brazilsouth', name: 'São Paulo (Brazil South)', lat: -23.55, lng: -46.63, gpus: ['T4'], priceFactor: 1.5, egressPerGb: 0.181 },
  { id: 'mexicocentral', name: 'Querétaro (Mexico Central)', lat: 20.59, lng: -100.39, gpus: ['T4'], priceFactor: 1.2, egressPerGb: 0.087 },
  { id: 'northeurope', name: 'Ireland (North Europe)', lat: 53.35, lng: -6.26, gpus: ['T4'], priceFactor: 1.1, egressPerGb: 0.087 },
  { id: 'ukwest', name: 'Cardiff (UK West)', lat: 51.48, lng: -3.18, gpus: ['T4'], priceFactor: 1.15, egressPerGb: 0.087 },
  { id: 'francecentral', name: 'Paris (France Central)', lat: 48.86, lng: 2.35, gpus: ['T4'], priceFactor: 1.15, egressPerGb: 0.087 },
  { id: 'germanywestcentral', name: 'Frankfurt (Germany West Central)', lat: 50.11, lng: 8.68, gpus: ['T4'], priceFactor: 1.15, egressPerGb: 0.087 },
  { id: 'switzerlandnorth', name: 'Zurich (Switzerland North)', lat: 47.37, lng: 8.54, gpus: ['T4'], priceFactor: 1.3, egressPerGb: 0.087 },
  { id: 'swedencentral', name: 'Stockholm (Sweden Central)', lat: 60.67, lng: 17.14, gpus: ['T4'], priceFactor: 1.05, egressPerGb: 0.087 },
  { id: 'norwayeast', name: 'Oslo (Norway East)', lat: 59.91, lng: 10.75, gpus: ['T4'], priceFactor: 1.25, egressPerGb: 0.087 },
  { id: 'polandcentral', name: 'Warsaw (Poland Central)', lat: 52.23, lng: 21.01, gpus: ['T4'], priceFactor: 1.2, egressPerGb: 0.087 },
  { id: 'italynorth', name: 'Milan (Italy North)', lat: 45.46, lng: 9.19, gpus: ['T4'], priceFactor: 1.2, egressPerGb: 0.087 },
  { id: 'spaincentral', name: 'Madrid (Spain Central)', lat: 40.42, lng: -3.7, gpus: ['T4'], priceFactor: 1.15, egressPerGb: 0.087 },
  { id: 'uaenorth', name: 'Dubai (UAE North)', lat: 25.2, lng: 55.27, gpus: ['T4'], priceFactor: 1.3, egressPerGb: 0.12 },
  { id: 'qatarcentral', name: 'Doha (Qatar Central)', lat: 25.29, lng: 51.53, gpus: ['T4'], priceFactor: 1.3, egressPerGb: 0.12 },
  { id: 'israelcentral', name: 'Tel Aviv (Israel Central)', lat: 32.08, lng: 34.78, gpus: ['T4'], priceFactor: 1.25, egressPerGb: 0.12 },
  { id: 'southafricanorth', name: 'Johannesburg (South Africa North)', lat: -26.2, lng: 28.05, gpus: ['T4'], priceFactor: 1.35, egressPerGb: 0.181 },
  { id: 'koreasouth', name: 'Busan (Korea South)', lat: 35.18, lng: 129.08, gpus: ['T4'], priceFactor: 1.3, egressPerGb: 0.12 },
  { id: 'indonesiacentral', name: 'Jakarta (Indonesia Central)', lat: -6.21, lng: 106.85, gpus: ['T4'], priceFactor: 1.3, egressPerGb: 0.12 },
  { id: 'newzealandnorth', name: 'Auckland (New Zealand North)', lat: -36.85, lng: 174.76, gpus: ['T4'], priceFactor: 1.45, egressPerGb: 0.12 },
  { id: 'westindia', name: 'Mumbai (West India)', lat: 19.08, lng: 72.88, gpus: ['T4'], priceFactor: 1.05, egressPerGb: 0.12 },
];

export const DEFAULT_REGION = 'southeastasia';

/**
 * OS disk type. "Premium_LRS" = Premium SSD: fast enough that games load
 * like on a gaming PC. (StandardSSD_LRS is about half the price but
 * noticeably slower at loading games.) Azure bills disks by SIZE TIER
 * rounded UP — a 150 GB disk is billed as a 256 GiB "P15" (~$38/month in
 * East US) — and you pay it while the machine exists, even when stopped.
 */
export const OS_DISK_SKU = 'Premium_LRS';
export const PREMIUM_DISK_PER_GB_MONTH = 0.15;
/** Incremental snapshots: ~$0.05 per GB actually used, per month. */
export const SNAPSHOT_PER_GB_MONTH = 0.05;

/** Rough spot discount: spot ≈ 30% of on-demand (varies by region and hour). */
export const SPOT_FACTOR = 0.3;

/**
 * Boot image: Canonical's Ubuntu 22.04 LTS, "gen2" (UEFI boot, which the
 * NCasT4_v3 sizes require). Our setup script is written for 22.04.
 */
export const UBUNTU_IMAGE = {
  publisher: 'Canonical',
  offer: '0001-com-ubuntu-server-jammy',
  sku: '22_04-lts-gen2',
  version: 'latest',
};

/** Every machine in a location goes into this resource group (a "folder" for Azure resources). */
export function resourceGroupFor(location: string): string {
  return `cloudgaming-hub-${location}`;
}

export function findShape(id: string): AzureShape | undefined {
  return AZURE_SHAPES.find((s) => s.id.toLowerCase() === String(id).toLowerCase());
}

export function findRegion(id: string): AzureRegion | undefined {
  return AZURE_REGIONS.find((r) => r.id === String(id).toLowerCase());
}

/** Estimated $/hour for a shape in a region. */
export function estimateHourly(shapeId: string, regionId: string, spot = false): number {
  const shape = findShape(shapeId);
  const region = findRegion(regionId);
  if (!shape) return 0;
  const onDemand = shape.eastUsOnDemand * (region?.priceFactor ?? 1.2);
  const price = spot ? onDemand * SPOT_FACTOR : onDemand;
  return Math.round(price * 1000) / 1000; // 3 decimal places
}

// ---------------------------------------------------------------------------
// The generic catalog the launch form reads (see shared/types.ts)
// ---------------------------------------------------------------------------

export const AZURE_CATALOG: ProviderCatalog = {
  provider: 'azure',
  label: 'Microsoft Azure',
  supportsSpot: true,
  spotLabel: 'Spot VM',
  defaultRegion: DEFAULT_REGION,
  defaultDiskGb: 150,
  minDiskGb: 64,
  regions: AZURE_REGIONS.map((r) => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, gpus: r.gpus, egressPerGb: r.egressPerGb })),
  shapes: AZURE_SHAPES.map((s) => ({ id: s.id, label: s.label, gpuModel: s.gpuModel, vcpus: s.vcpus, memoryGb: s.memoryGb, bestFor: s.bestFor })),
  estimateHourly: (shapeId, regionId, spot) => estimateHourly(shapeId, regionId, spot),
  diskPerGbMonth: PREMIUM_DISK_PER_GB_MONTH,
  snapshotPerGbMonth: SNAPSHOT_PER_GB_MONTH,
  restoreAnyRegion: false,
  priceNote:
    'Rough estimates from Azure\'s East US list prices × a region factor (±20%); excludes tax. ' +
    'Spot prices change constantly. Disks are billed by size tier rounded up (150 GB → 256 GB tier), even while stopped. ' +
    'A stopped machine also keeps its static public IP (~USD 3.60/month).',
};
