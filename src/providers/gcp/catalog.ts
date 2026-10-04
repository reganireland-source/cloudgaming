/**
 * ============================================================================
 * src/providers/gcp/catalog.ts — WHAT CAN BE LAUNCHED ON GOOGLE CLOUD, AND ~COST
 * ============================================================================
 *
 * The launch form's choices come from here (via GET /api/machines/options):
 *   - REGIONS: where Google offers T4 and/or L4 GPUs, with approximate
 *     location (for "nearest to you") and price adjustments.
 *   - SHAPES:  the machine sizes we offer. A "shape" = a Google machine type
 *     plus (for N1 machines) an attached GPU.
 *
 * ABOUT THE PRICES
 * ----------------
 * These are ESTIMATES in US dollars per hour, based on Google's published
 * us-central1 on-demand list prices, scaled by a per-region factor. Real
 * prices vary by region, change over time, and exclude tax/discounts. Spot
 * prices move daily; we assume ~40% of on-demand. The UI labels them "≈".
 * For exact numbers use https://cloud.google.com/products/calculator.
 * (Reading live prices needs the Cloud Billing Catalog API — a possible
 * future improvement.)
 * ============================================================================
 */

export interface GcpShape {
  id: string;               // our id, stored in machines.instance_type
  label: string;            // shown in the launch form
  machineType: string;      // Google's machine type name
  gpuType?: string;         // accelerator to attach (N1 only; G2 has its GPU built in)
  gpuModel: 'T4' | 'L4' | 'RTX PRO 6000';
  gpuQuotaMetric: string;   // the regional quota that must be ≥ 1
  spotQuotaMetric?: string; // spot's quota, if not PREEMPTIBLE_ + gpuQuotaMetric
  vcpus: number;
  memoryGb: number;
  usCentralOnDemand: number; // $/hour, machine + GPU, us-central1
  bestFor: string;
}

export const GCP_SHAPES: GcpShape[] = [
  {
    id: 'n1-standard-4+t4',
    label: 'T4 · 4 vCPU · 15 GB RAM',
    machineType: 'n1-standard-4',
    gpuType: 'nvidia-tesla-t4',
    gpuModel: 'T4',
    gpuQuotaMetric: 'NVIDIA_T4_GPUS',
    vcpus: 4,
    memoryGb: 15,
    usCentralOnDemand: 0.19 + 0.35,
    bestFor: 'Indie, esports and older AAA games at 1080p60. Cheapest option.',
  },
  {
    id: 'n1-standard-8+t4',
    label: 'T4 · 8 vCPU · 30 GB RAM',
    machineType: 'n1-standard-8',
    gpuType: 'nvidia-tesla-t4',
    gpuModel: 'T4',
    gpuQuotaMetric: 'NVIDIA_T4_GPUS',
    vcpus: 8,
    memoryGb: 30,
    usCentralOnDemand: 0.38 + 0.35,
    bestFor: 'CPU-heavy games (strategy, simulators) at 1080p60.',
  },
  {
    id: 'g2-standard-4',
    label: 'L4 · 4 vCPU · 16 GB RAM',
    machineType: 'g2-standard-4',
    gpuModel: 'L4',
    gpuQuotaMetric: 'NVIDIA_L4_GPUS',
    vcpus: 4,
    memoryGb: 16,
    usCentralOnDemand: 0.71,
    bestFor: 'Modern AAA games at 1440p60. About 2–3× a T4\'s gaming performance.',
  },
  {
    id: 'g2-standard-8',
    label: 'L4 · 8 vCPU · 32 GB RAM',
    machineType: 'g2-standard-8',
    gpuModel: 'L4',
    gpuQuotaMetric: 'NVIDIA_L4_GPUS',
    vcpus: 8,
    memoryGb: 32,
    usCentralOnDemand: 0.85,
    bestFor: 'Demanding AAA games at 1440p–4K60.',
  },
  {
    // SUPER tier. G4 = RTX PRO 6000 Blackwell (GB202, the RTX 5090's chip),
    // 96 GB, DLSS 4 multi-frame generation. Built-in GPU like G2, but needs a
    // Hyperdisk boot disk and the gVNIC network card. Smallest G4 is 48 vCPU.
    // Quota is GPU-only (no CPU quota for G4): the per-family quota
    // "GPUs per GPU family" (gpu_family=NVIDIA_RTX_PRO_6000), and for spot
    // PREEMPTIBLE_NVIDIA_RTX_PRO_6000_GPUS.
    id: 'g4-standard-48',
    label: 'RTX PRO 6000 · 48 vCPU · 180 GB RAM',
    machineType: 'g4-standard-48',
    gpuModel: 'RTX PRO 6000',
    gpuQuotaMetric: 'GPU_FAMILY:NVIDIA_RTX_PRO_6000',
    spotQuotaMetric: 'PREEMPTIBLE_NVIDIA_RTX_PRO_6000_GPUS',
    vcpus: 48,
    memoryGb: 180,
    usCentralOnDemand: 4.5,
    bestFor: 'The fastest GPU any cloud rents: modern AAA with path tracing and DLSS 4 at 4K120.',
  },
];

/** G4 machines: Hyperdisk boot disk + gVNIC required, no vWS (big screen) driver. */
export const isG4 = (machineType: string) => machineType.startsWith('g4-');

/** The quota a spot machine of this shape uses. */
export const spotMetricOf = (s: Pick<GcpShape, 'gpuQuotaMetric' | 'spotQuotaMetric'>) => s.spotQuotaMetric || `PREEMPTIBLE_${s.gpuQuotaMetric}`;

/**
 * How to ask for a quota by metric: the Cloud Quotas quota id, its
 * dimensions and the console filter. GPU_FAMILY:X = GPUS-PER-GPU-FAMILY
 * with gpu_family=X.
 */
export function quotaRequestOf(metric: string, region?: string): { quotaId: string; dims: string; consoleMetric: string } {
  if (metric.startsWith('GPU_FAMILY:')) {
    return { quotaId: 'GPUS-PER-GPU-FAMILY-per-project-region', dims: ` --dimensions=region=${region},gpu_family=${metric.slice(11)}`, consoleMetric: 'gpus_per_gpu_family' };
  }
  if (metric === 'GPUS_ALL_REGIONS') return { quotaId: 'GPUS-ALL-REGIONS-per-project', dims: '', consoleMetric: 'gpus_all_regions' };
  return { quotaId: `${metric.replace(/_/g, '-')}-per-project-region`, dims: ` --dimensions=region=${region}`, consoleMetric: metric.toLowerCase() };
}

/** "NVIDIA_L4_GPUS" / "PREEMPTIBLE_NVIDIA_RTX_PRO_6000_GPUS" / "GPU_FAMILY:NVIDIA_RTX_PRO_6000" → "L4" / "RTX PRO 6000". */
export const gpuOfMetric = (metric: string) =>
  metric.replace(/^GPU_FAMILY:/, '').replace(/^PREEMPTIBLE_/, '').replace(/^NVIDIA_/, '').replace(/(_VWS)?_GPUS$/, '').replace(/_/g, ' ');

export interface GcpRegion {
  id: string;
  name: string;
  lat: number;
  lng: number;
  zones: string[];          // zone letters to try, in order
  gpus: Array<'T4' | 'L4' | 'RTX PRO 6000'>; // GPU models Google offers here
  priceFactor: number;      // multiplier vs us-central1 (approximate)
  egressPerGb: number;      // $/GB to the internet, premium tier, first TB (approximate)
}

export const GCP_REGIONS: GcpRegion[] = [
  { id: 'asia-southeast1', name: 'Singapore', lat: 1.35, lng: 103.82, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.23, egressPerGb: 0.12 },
  // GPU lists checked against Google's T4 and G2 (L4) price lists per location.
  // Zones: the launch tries each listed zone and skips ones without the GPU.
  { id: 'australia-southeast1', name: 'Sydney', lat: -33.87, lng: 151.21, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.35, egressPerGb: 0.19 },
  { id: 'australia-southeast2', name: 'Melbourne', lat: -37.81, lng: 144.96, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.35, egressPerGb: 0.19 },
  { id: 'asia-northeast1', name: 'Tokyo', lat: 35.68, lng: 139.69, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.29, egressPerGb: 0.12 },
  { id: 'asia-northeast2', name: 'Osaka', lat: 34.69, lng: 135.5, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4'], priceFactor: 1.29, egressPerGb: 0.12 },
  { id: 'asia-northeast3', name: 'Seoul', lat: 37.57, lng: 126.98, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4'], priceFactor: 1.25, egressPerGb: 0.12 },
  { id: 'asia-east2', name: 'Hong Kong', lat: 22.32, lng: 114.17, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4'], priceFactor: 1.4, egressPerGb: 0.12 },
  { id: 'asia-east1', name: 'Taiwan', lat: 24.07, lng: 120.54, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.08, egressPerGb: 0.12 },
  { id: 'asia-south1', name: 'Mumbai', lat: 19.08, lng: 72.88, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.2, egressPerGb: 0.12 },
  { id: 'us-central1', name: 'Iowa', lat: 41.26, lng: -95.86, zones: ['a', 'b', 'c', 'f'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.0, egressPerGb: 0.12 },
  { id: 'us-west1', name: 'Oregon', lat: 45.6, lng: -121.18, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.0, egressPerGb: 0.12 },
  { id: 'us-west2', name: 'Los Angeles', lat: 34.05, lng: -118.24, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.2, egressPerGb: 0.12 },
  { id: 'us-east4', name: 'N. Virginia', lat: 39.04, lng: -77.49, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.12, egressPerGb: 0.12 },
  { id: 'europe-west4', name: 'Netherlands', lat: 53.44, lng: 6.84, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.1, egressPerGb: 0.12 },
  { id: 'europe-west2', name: 'London', lat: 51.51, lng: -0.13, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.2, egressPerGb: 0.12 },
  // Every other Google Cloud region, 2026. KEEP ADDING AT THE END: each
  // region's subnet range comes from its position in this list
  // (subnetCidrFor), so reordering would clash with networks already made.
  // Newer regions sell few GPUs: the launch asks Google live which zones sell
  // the GPU, and the Regions page shows "Not sold here" / "only T4" where
  // these lists are too hopeful.
  { id: 'europe-west1', name: 'Belgium', lat: 50.45, lng: 3.82, zones: ['b', 'c', 'd'], gpus: ['T4', 'L4'], priceFactor: 1.1, egressPerGb: 0.12 },
  { id: 'europe-west3', name: 'Frankfurt', lat: 50.11, lng: 8.68, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4'], priceFactor: 1.29, egressPerGb: 0.12 },
  { id: 'europe-west6', name: 'Zurich', lat: 47.37, lng: 8.54, zones: ['a', 'b', 'c'], gpus: ['L4'], priceFactor: 1.4, egressPerGb: 0.12 },
  { id: 'europe-west8', name: 'Milan', lat: 45.46, lng: 9.19, zones: ['a', 'b', 'c'], gpus: ['L4', 'RTX PRO 6000'], priceFactor: 1.2, egressPerGb: 0.12 },
  { id: 'europe-west9', name: 'Paris', lat: 48.86, lng: 2.35, zones: ['a', 'b', 'c'], gpus: ['L4'], priceFactor: 1.2, egressPerGb: 0.12 },
  { id: 'europe-west10', name: 'Berlin', lat: 52.52, lng: 13.4, zones: ['a', 'b', 'c'], gpus: ['L4'], priceFactor: 1.3, egressPerGb: 0.12 },
  { id: 'europe-west12', name: 'Turin', lat: 45.07, lng: 7.69, zones: ['a', 'b', 'c'], gpus: ['L4'], priceFactor: 1.2, egressPerGb: 0.12 },
  { id: 'europe-central2', name: 'Warsaw', lat: 52.23, lng: 21.01, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.29, egressPerGb: 0.12 },
  { id: 'europe-north1', name: 'Finland', lat: 60.57, lng: 27.19, zones: ['a', 'b', 'c'], gpus: ['L4'], priceFactor: 1.1, egressPerGb: 0.12 },
  { id: 'europe-north2', name: 'Stockholm', lat: 59.33, lng: 18.07, zones: ['a', 'b', 'c'], gpus: ['L4'], priceFactor: 1.1, egressPerGb: 0.12 },
  { id: 'europe-southwest1', name: 'Madrid', lat: 40.42, lng: -3.7, zones: ['a', 'b', 'c'], gpus: ['L4'], priceFactor: 1.18, egressPerGb: 0.12 },
  { id: 'me-west1', name: 'Tel Aviv', lat: 32.08, lng: 34.78, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4'], priceFactor: 1.2, egressPerGb: 0.12 },
  { id: 'me-central1', name: 'Doha', lat: 25.29, lng: 51.53, zones: ['a', 'b', 'c'], gpus: ['L4'], priceFactor: 1.3, egressPerGb: 0.12 },
  { id: 'me-central2', name: 'Dammam', lat: 26.43, lng: 50.1, zones: ['a', 'b', 'c'], gpus: ['L4', 'RTX PRO 6000'], priceFactor: 1.3, egressPerGb: 0.12 },
  { id: 'africa-south1', name: 'Johannesburg', lat: -26.2, lng: 28.05, zones: ['a', 'b', 'c'], gpus: ['L4'], priceFactor: 1.3, egressPerGb: 0.12 },
  { id: 'asia-southeast2', name: 'Jakarta', lat: -6.21, lng: 106.85, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.29, egressPerGb: 0.12 },
  { id: 'asia-south2', name: 'Delhi', lat: 28.61, lng: 77.21, zones: ['a', 'b', 'c'], gpus: ['L4', 'RTX PRO 6000'], priceFactor: 1.2, egressPerGb: 0.12 },
  { id: 'us-east1', name: 'S. Carolina', lat: 33.2, lng: -80.01, zones: ['b', 'c', 'd'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.0, egressPerGb: 0.12 },
  { id: 'us-east5', name: 'Columbus', lat: 39.96, lng: -83.0, zones: ['a', 'b', 'c'], gpus: ['L4', 'RTX PRO 6000'], priceFactor: 1.0, egressPerGb: 0.12 },
  { id: 'us-south1', name: 'Dallas', lat: 32.78, lng: -96.8, zones: ['a', 'b', 'c'], gpus: ['L4'], priceFactor: 1.18, egressPerGb: 0.12 },
  { id: 'us-west3', name: 'Salt Lake City', lat: 40.76, lng: -111.89, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.2, egressPerGb: 0.12 },
  { id: 'us-west4', name: 'Las Vegas', lat: 36.17, lng: -115.14, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.12, egressPerGb: 0.12 },
  { id: 'northamerica-northeast1', name: 'Montréal', lat: 45.5, lng: -73.57, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4', 'RTX PRO 6000'], priceFactor: 1.1, egressPerGb: 0.12 },
  { id: 'northamerica-northeast2', name: 'Toronto', lat: 43.65, lng: -79.38, zones: ['a', 'b', 'c'], gpus: ['L4', 'RTX PRO 6000'], priceFactor: 1.1, egressPerGb: 0.12 },
  { id: 'northamerica-south1', name: 'Querétaro (Mexico)', lat: 20.59, lng: -100.39, zones: ['a', 'b', 'c'], gpus: ['L4', 'RTX PRO 6000'], priceFactor: 1.2, egressPerGb: 0.12 },
  { id: 'southamerica-east1', name: 'São Paulo', lat: -23.55, lng: -46.63, zones: ['a', 'b', 'c'], gpus: ['T4', 'L4'], priceFactor: 1.59, egressPerGb: 0.12 },
  { id: 'southamerica-west1', name: 'Santiago', lat: -33.45, lng: -70.67, zones: ['a', 'b', 'c'], gpus: ['L4'], priceFactor: 1.4, egressPerGb: 0.12 },
];

export const DEFAULT_REGION = 'asia-southeast1';

/** Disk prices, $/GB/month (approximate). */
export const BALANCED_DISK_PER_GB_MONTH = 0.11;
export const SNAPSHOT_PER_GB_MONTH = 0.029;

/** Rough spot discount: spot ≈ 40% of on-demand. */
export const SPOT_FACTOR = 0.4;

/** Boot disk: Ubuntu 22.04 LTS, the OS our setup script is written for. */
export const BOOT_IMAGE = 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts';

/** Firewall rule + network tag that open the streaming ports. */
// Our own VPC network (like CloudyPad) instead of the project's "default"
// one, which some organisations remove by policy. Custom mode: we create one
// subnet per region we use, named cloudgaming-<region>.
export const NETWORK_NAME = 'cloudgaming-net';
export const FIREWALL_RULE_NAME = 'cloudgaming-net-sunshine';
export const NETWORK_TAG = 'cloudgaming-sunshine';

/** A unique private address range per region: 10.<64+index>.0.0/20. */
export function subnetCidrFor(regionId: string): string {
  const index = Math.max(0, GCP_REGIONS.findIndex((r) => r.id === regionId));
  return `10.${64 + index}.0.0/20`;
}

/**
 * Ports used by Sunshine (the streaming server on the machine) and
 * Moonlight (the app you play on). 47990 is Sunshine's web admin page.
 */
export { SUNSHINE_TCP_PORTS, SUNSHINE_UDP_PORTS } from '../shared/streaming';

export function findShape(id: string): GcpShape | undefined {
  return GCP_SHAPES.find((s) => s.id === id);
}

export function findRegion(id: string): GcpRegion | undefined {
  return GCP_REGIONS.find((r) => r.id === id);
}

/** Estimated $/hour for a shape in a region. */
export function estimateHourly(shapeId: string, regionId: string, spot = false): number {
  const shape = findShape(shapeId);
  const region = findRegion(regionId);
  if (!shape) return 0;
  const onDemand = shape.usCentralOnDemand * (region?.priceFactor ?? 1.2);
  const price = spot ? onDemand * SPOT_FACTOR : onDemand;
  return Math.round(price * 1000) / 1000; // 3 decimal places
}

// ---------------------------------------------------------------------------
// The generic catalog the launch form reads (see shared/types.ts)
// ---------------------------------------------------------------------------
import type { ProviderCatalog } from '../shared/types';

export const GCP_CATALOG: ProviderCatalog = {
  provider: 'gcp',
  label: 'Google Cloud',
  supportsSpot: true,
  spotLabel: 'Spot VM',
  defaultRegion: DEFAULT_REGION,
  defaultDiskGb: 150,
  minDiskGb: 50,
  regions: GCP_REGIONS.map((r) => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, gpus: r.gpus, egressPerGb: r.egressPerGb })),
  shapes: GCP_SHAPES.map((s) => ({ id: s.id, label: s.label, gpuModel: s.gpuModel, vcpus: s.vcpus, memoryGb: s.memoryGb, bestFor: s.bestFor })),
  estimateHourly: (shapeId, regionId, spot) => estimateHourly(shapeId, regionId, spot),
  diskPerGbMonth: BALANCED_DISK_PER_GB_MONTH,
  snapshotPerGbMonth: SNAPSHOT_PER_GB_MONTH,
  restoreAnyRegion: true,
  bigScreen: { available: true, extraPerHour: 0.2, note: 'Uses Google\'s "vWS" (virtual workstation) GPUs: an extra licence charge per GPU-hour (≈USD 0.20, estimate) and their OWN quota — request "NVIDIA T4 Virtual Workstation GPUs" or "NVIDIA L4 Virtual Workstation GPUs" in the region first. Not on the RTX PRO 6000 (no vWS version).', notOnGpus: ['RTX PRO 6000'] },
  priceNote: 'Estimates from Google\'s list prices (±15%); excludes tax and discounts. Spot prices move daily.',
};
