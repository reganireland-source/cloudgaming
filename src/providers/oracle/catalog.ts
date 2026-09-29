/**
 * ============================================================================
 * src/providers/oracle/catalog.ts — WHAT CAN BE LAUNCHED ON ORACLE CLOUD, AND ~COST
 * ============================================================================
 *
 * The launch form's choices come from here (via GET /api/machines/options):
 *   - REGIONS: Oracle regions where (to the best of our knowledge) GPU VM
 *     shapes are offered, with approximate location for "nearest to you".
 *   - SHAPES:  the GPU machine sizes we offer. On Oracle a "shape" is a
 *     fixed bundle of GPU + CPU + memory, e.g. VM.GPU.A10.1.
 *
 * ORACLE-SPECIFIC FACTS WORTH KNOWING
 * -----------------------------------
 * - OCPU: Oracle counts CPUs in "OCPUs". One OCPU = one physical core =
 *   2 vCPUs, so VM.GPU.A10.1's 15 OCPUs are 30 vCPUs.
 * - SAME PRICE EVERYWHERE: Oracle charges the same list price in every
 *   commercial region, so there's no per-region price factor here.
 * - GPU prices INCLUDE the CPU and memory of the shape (billed per GPU-hour).
 * - SERVICE LIMITS: every new Oracle account has a GPU limit of 0. The user
 *   must request an increase (Governance → Limits) before anything launches.
 * - EGRESS: the first 10 TB of internet egress per month is free across the
 *   whole account. Game streaming uses roughly 5–15 GB per hour, so most
 *   people never pay for egress on Oracle. Beyond 10 TB it's about
 *   $0.0085/GB (Americas/Europe) or $0.025/GB (Asia-Pacific).
 * - PREEMPTIBLE ("spot"): about 50% off, but Oracle may reclaim the machine
 *   at any time, and a preemptible machine can't be stopped and restarted —
 *   only deleted. So you'd snapshot before you finish playing.
 *
 * ABOUT THE PRICES
 * ----------------
 * US-dollar list prices from memory of Oracle's public price list, NOT
 * fetched live — treat them as "≈" (the UI does). Check
 * https://www.oracle.com/cloud/price-list/ or the cost estimator for exact
 * numbers. Excludes tax; Oracle Universal Credits/commit discounts not applied.
 * ============================================================================
 */

import type { ProviderCatalog } from '../shared/types';

export interface OracleShape {
  id: string;               // Oracle's shape name, also stored in machines.instance_type
  label: string;            // shown in the launch form
  gpuModel: 'A10';
  gpuMemoryGb: number;
  ocpus: number;            // Oracle CPUs (1 OCPU = 2 vCPUs)
  vcpus: number;
  memoryGb: number;
  onDemand: number;         // $/hour, list price (includes CPU + memory)
  bestFor: string;
}

export const ORACLE_SHAPES: OracleShape[] = [
  {
    id: 'VM.GPU.A10.1',
    label: 'A10 (24 GB) · 30 vCPU · 240 GB RAM',
    gpuModel: 'A10',
    gpuMemoryGb: 24,
    ocpus: 15,
    vcpus: 30,
    memoryGb: 240,
    onDemand: 2.0,
    bestFor: 'Modern AAA games at 1440p–4K60. Roughly RTX 3070-class, with a modern NVENC encoder. Oracle\'s smallest current GPU VM.',
  },
  // VM.GPU2.1 (P100, Pascal) was removed: the NVIDIA datacenter driver we
  // install (590 branch, the one CloudyPad pins) no longer supports Pascal
  // GPUs, so the machine would boot with no usable GPU. The P100's video
  // encoder is also too old for good streaming.
];

export interface OracleRegion {
  id: string;
  name: string;
  lat: number;
  lng: number;
  gpus: Array<'A10'>;  // GPU models offered here (best knowledge — may change)
  egressPerGb: number;           // $/GB to the internet; 0 because the first 10 TB/month are free
  egressOverPerGb: number;       // $/GB after the free 10 TB (informational)
}

// GPU availability per region is best knowledge, not fetched live: Oracle
// adds/removes GPU capacity often. A wrong guess just shows up as an
// "Out of host capacity" / "shape not found" error at launch time.
export const ORACLE_REGIONS: OracleRegion[] = [
  { id: 'ap-singapore-1', name: 'Singapore', lat: 1.35, lng: 103.82, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'ap-sydney-1', name: 'Sydney', lat: -33.87, lng: 151.21, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'ap-tokyo-1', name: 'Tokyo', lat: 35.68, lng: 139.69, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'ap-osaka-1', name: 'Osaka', lat: 34.69, lng: 135.5, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'ap-chuncheon-1', name: 'Chuncheon (near Seoul)', lat: 37.88, lng: 127.73, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'ap-mumbai-1', name: 'Mumbai', lat: 19.08, lng: 72.88, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'ap-hyderabad-1', name: 'Hyderabad', lat: 17.39, lng: 78.49, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'ap-melbourne-1', name: 'Melbourne', lat: -37.81, lng: 144.96, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'us-ashburn-1', name: 'Ashburn (N. Virginia)', lat: 39.04, lng: -77.49, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'us-phoenix-1', name: 'Phoenix', lat: 33.45, lng: -112.07, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'eu-frankfurt-1', name: 'Frankfurt', lat: 50.11, lng: 8.68, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'uk-london-1', name: 'London', lat: 51.51, lng: -0.13, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  // Every other commercial Oracle region, 2026. A region must be subscribed
  // in your tenancy first (the Regions page shows "Not enabled" with the
  // fix). Where Oracle has no A10 GPUs, the Regions page shows "Not sold
  // here" (the region lists no A10 limit at all).
  { id: 'ap-seoul-1', name: 'Seoul', lat: 37.57, lng: 126.98, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'ap-singapore-2', name: 'Singapore West', lat: 1.35, lng: 103.7, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'ap-batam-1', name: 'Batam (Indonesia)', lat: 1.13, lng: 104.05, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'us-sanjose-1', name: 'San Jose', lat: 37.34, lng: -121.89, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'us-chicago-1', name: 'Chicago', lat: 41.88, lng: -87.63, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'ca-toronto-1', name: 'Toronto', lat: 43.65, lng: -79.38, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'ca-montreal-1', name: 'Montréal', lat: 45.5, lng: -73.57, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'mx-queretaro-1', name: 'Querétaro (Mexico)', lat: 20.59, lng: -100.39, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'mx-monterrey-1', name: 'Monterrey', lat: 25.69, lng: -100.32, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'sa-saopaulo-1', name: 'São Paulo', lat: -23.55, lng: -46.63, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'sa-vinhedo-1', name: 'Vinhedo (near São Paulo)', lat: -23.03, lng: -46.98, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'sa-santiago-1', name: 'Santiago', lat: -33.45, lng: -70.67, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'sa-valparaiso-1', name: 'Valparaíso', lat: -33.05, lng: -71.62, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'sa-bogota-1', name: 'Bogotá', lat: 4.71, lng: -74.07, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'eu-amsterdam-1', name: 'Amsterdam', lat: 52.37, lng: 4.9, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'uk-cardiff-1', name: 'Newport (Wales)', lat: 51.59, lng: -2.99, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'eu-paris-1', name: 'Paris', lat: 48.86, lng: 2.35, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'eu-marseille-1', name: 'Marseille', lat: 43.3, lng: 5.37, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'eu-zurich-1', name: 'Zurich', lat: 47.37, lng: 8.54, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'eu-milan-1', name: 'Milan', lat: 45.46, lng: 9.19, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'eu-madrid-1', name: 'Madrid', lat: 40.42, lng: -3.7, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'eu-stockholm-1', name: 'Stockholm', lat: 59.33, lng: 18.07, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'eu-jovanovac-1', name: 'Jovanovac (Serbia)', lat: 44.02, lng: 20.9, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'il-jerusalem-1', name: 'Jerusalem', lat: 31.77, lng: 35.21, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'me-dubai-1', name: 'Dubai', lat: 25.2, lng: 55.27, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'me-abudhabi-1', name: 'Abu Dhabi', lat: 24.45, lng: 54.38, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'me-jeddah-1', name: 'Jeddah', lat: 21.49, lng: 39.19, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'me-riyadh-1', name: 'Riyadh', lat: 24.71, lng: 46.68, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
  { id: 'af-johannesburg-1', name: 'Johannesburg', lat: -26.2, lng: 28.05, gpus: ['A10'], egressPerGb: 0, egressOverPerGb: 0.025 },
];

export const DEFAULT_REGION = 'ap-singapore-1';
export const DEFAULT_SHAPE = 'VM.GPU.A10.1';

/**
 * Boot volume price, $/GB/month, at Oracle's default "Balanced" performance:
 * storage $0.0255 + 10 performance units × $0.0017 = $0.0425.
 */
export const BOOT_VOLUME_PER_GB_MONTH = 0.0255 + 10 * 0.0017;
/** Boot volume BACKUPS (our "snapshots") are stored in Object Storage: ≈ $0.0255/GB/month. */
export const BACKUP_PER_GB_MONTH = 0.0255;

/** Preemptible machines are ~50% of the on-demand price. */
export const PREEMPTIBLE_FACTOR = 0.5;

/** Operating system we launch; our setup script is written for it. */
export const IMAGE_OS = 'Canonical Ubuntu';
export const IMAGE_OS_VERSION = '22.04';

/** Names of the network pieces we create (once per region & compartment). */
export const VCN_NAME = 'cloudgaming-vcn';
export const SUBNET_NAME = 'cloudgaming-public';
export const IGW_NAME = 'cloudgaming-igw';
export const VCN_CIDR = '10.77.0.0/16';
export const SUBNET_CIDR = '10.77.1.0/24';

export function findShape(id: string): OracleShape | undefined {
  return ORACLE_SHAPES.find((s) => s.id === id);
}

export function findRegion(id: string): OracleRegion | undefined {
  return ORACLE_REGIONS.find((r) => r.id === id);
}

/** Estimated $/hour for a shape (same in every region on Oracle). */
export function estimateHourly(shapeId: string, _regionId: string, spot = false): number {
  const shape = findShape(shapeId);
  if (!shape) return 0;
  const price = spot ? shape.onDemand * PREEMPTIBLE_FACTOR : shape.onDemand;
  return Math.round(price * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// The generic catalog the launch form reads (see shared/types.ts)
// ---------------------------------------------------------------------------

export const ORACLE_CATALOG: ProviderCatalog = {
  provider: 'oracle',
  label: 'Oracle Cloud',
  supportsSpot: true,
  spotLabel: 'Preemptible',
  defaultRegion: DEFAULT_REGION,
  defaultDiskGb: 150,
  minDiskGb: 50,
  regions: ORACLE_REGIONS.map((r) => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, gpus: r.gpus, egressPerGb: r.egressPerGb })),
  shapes: ORACLE_SHAPES.map((s) => ({ id: s.id, label: s.label, gpuModel: s.gpuModel, vcpus: s.vcpus, memoryGb: s.memoryGb, bestFor: s.bestFor })),
  estimateHourly: (shapeId, regionId, spot) => estimateHourly(shapeId, regionId, spot),
  diskPerGbMonth: BOOT_VOLUME_PER_GB_MONTH,
  snapshotPerGbMonth: BACKUP_PER_GB_MONTH,
  restoreAnyRegion: false,
  bigScreen: { available: false, extraPerHour: 0, note: 'Not available: Oracle requires your own NVIDIA virtual-workstation licence (bring your own licence).' },
  priceNote:
    'Approximate Oracle list prices (same in every region; GPU price includes CPU and memory), not fetched live. ' +
    'First 10 TB/month of internet egress is free, so streaming data is usually USD 0. ' +
    'New accounts have a GPU service limit of 0 — request an increase (Governance → Limits) before launching. ' +
    'Preemptible ≈ 50% off, can be reclaimed at any time, and can\'t be stopped — only deleted (snapshot first).',
};
