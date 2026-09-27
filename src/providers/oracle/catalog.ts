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
  gpuModel: 'A10' | 'P100';
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
  {
    id: 'VM.GPU2.1',
    label: 'P100 (16 GB) · 24 vCPU · 72 GB RAM — legacy',
    gpuModel: 'P100',
    gpuMemoryGb: 16,
    ocpus: 12,
    vcpus: 24,
    memoryGb: 72,
    onDemand: 1.275,
    bestFor: 'Older/lighter games at 1080p. 2016-era datacenter GPU with an old, weaker video encoder; only in a few regions and being phased out. Prefer A10.',
  },
];

export interface OracleRegion {
  id: string;
  name: string;
  lat: number;
  lng: number;
  gpus: Array<'A10' | 'P100'>;  // GPU models offered here (best knowledge — may change)
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
  { id: 'us-ashburn-1', name: 'Ashburn (N. Virginia)', lat: 39.04, lng: -77.49, gpus: ['A10', 'P100'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'us-phoenix-1', name: 'Phoenix', lat: 33.45, lng: -112.07, gpus: ['A10', 'P100'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'eu-frankfurt-1', name: 'Frankfurt', lat: 50.11, lng: 8.68, gpus: ['A10', 'P100'], egressPerGb: 0, egressOverPerGb: 0.0085 },
  { id: 'uk-london-1', name: 'London', lat: 51.51, lng: -0.13, gpus: ['A10', 'P100'], egressPerGb: 0, egressOverPerGb: 0.0085 },
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
  priceNote:
    'Approximate Oracle list prices (same in every region; GPU price includes CPU and memory), not fetched live. ' +
    'First 10 TB/month of internet egress is free, so streaming data is usually $0. ' +
    'New accounts have a GPU service limit of 0 — request an increase (Governance → Limits) before launching. ' +
    'Preemptible ≈ 50% off, can be reclaimed at any time, and can\'t be stopped — only deleted (snapshot first).',
};
