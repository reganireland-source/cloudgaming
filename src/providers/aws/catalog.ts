/**
 * ============================================================================
 * src/providers/aws/catalog.ts — WHAT CAN BE LAUNCHED ON AWS, AND ~COST
 * ============================================================================
 *
 * The launch form's choices come from here (via GET /api/machines/options):
 *   - REGIONS: AWS regions that sell NVIDIA GPU machines, with approximate
 *     location (for "nearest to you") and price adjustments.
 *   - SHAPES:  the machine sizes we offer. On AWS the GPU is built into the
 *     "instance type" — g4dn = NVIDIA T4, g5 = NVIDIA A10G — so a shape is
 *     just an instance type name (unlike Google, where you attach a GPU).
 *
 * ABOUT THE PRICES
 * ----------------
 * These are ESTIMATES in US dollars per hour for LINUX machines, based on
 * AWS's published us-east-1 (N. Virginia) on-demand list prices, scaled by
 * a per-region factor. Real prices vary, change over time, and exclude tax.
 * Spot prices float with demand; we assume ~35% of on-demand, which is
 * typical for g4dn/g5 but can be much higher when capacity is tight. The UI
 * labels all of these "≈". Exact numbers: https://aws.amazon.com/ec2/pricing/
 * (Reading live prices needs the AWS Pricing API and DescribeSpotPriceHistory
 * — a possible future improvement.)
 *
 * GPU AVAILABILITY per region is to the best of our knowledge (2025–26);
 * AWS adds instance types to regions over time. Even where a type is
 * offered, not every availability zone has it — the provider tries each zone.
 * ============================================================================
 */

import type { ProviderCatalog } from '../shared/types';

export interface AwsShape {
  id: string;               // the AWS instance type — also stored in machines.instance_type
  label: string;            // shown in the launch form
  gpuModel: 'T4' | 'A10G';
  vcpus: number;
  memoryGb: number;
  usEastOnDemand: number;   // $/hour, Linux, us-east-1
  bestFor: string;
}

export const AWS_SHAPES: AwsShape[] = [
  {
    id: 'g4dn.xlarge',
    label: 'T4 · 4 vCPU · 16 GB RAM',
    gpuModel: 'T4',
    vcpus: 4,
    memoryGb: 16,
    usEastOnDemand: 0.526,
    bestFor: 'Indie, esports and older AAA games at 1080p60. Cheapest option.',
  },
  {
    id: 'g4dn.2xlarge',
    label: 'T4 · 8 vCPU · 32 GB RAM',
    gpuModel: 'T4',
    vcpus: 8,
    memoryGb: 32,
    usEastOnDemand: 0.752,
    bestFor: 'CPU-heavy games (strategy, simulators) at 1080p60.',
  },
  {
    id: 'g5.xlarge',
    label: 'A10G · 4 vCPU · 16 GB RAM',
    gpuModel: 'A10G',
    vcpus: 4,
    memoryGb: 16,
    usEastOnDemand: 1.006,
    bestFor: 'Modern AAA games at 1440p60. Roughly 2–3× a T4\'s gaming performance.',
  },
  {
    id: 'g5.2xlarge',
    label: 'A10G · 8 vCPU · 32 GB RAM',
    gpuModel: 'A10G',
    vcpus: 8,
    memoryGb: 32,
    usEastOnDemand: 1.212,
    bestFor: 'Demanding AAA games at 1440p–4K60.',
  },
];

export interface AwsRegion {
  id: string;
  name: string;
  lat: number;
  lng: number;
  gpus: Array<'T4' | 'A10G'>; // GPU models AWS offers here
  priceFactor: number;         // multiplier vs us-east-1 (approximate)
  egressPerGb: number;         // $/GB to the internet, first 10 TB/month (approximate)
}

export const AWS_REGIONS: AwsRegion[] = [
  // GPU lists checked against AWS's Spot Instance Advisor data (which types
  // each region offers). Singapore has g4dn (T4) but no g5 (A10G).
  { id: 'ap-southeast-1', name: 'Singapore', lat: 1.35, lng: 103.82, gpus: ['T4'], priceFactor: 1.4, egressPerGb: 0.12 },
  { id: 'ap-southeast-2', name: 'Sydney', lat: -33.87, lng: 151.21, gpus: ['T4', 'A10G'], priceFactor: 1.5, egressPerGb: 0.114 },
  { id: 'ap-northeast-1', name: 'Tokyo', lat: 35.68, lng: 139.69, gpus: ['T4', 'A10G'], priceFactor: 1.35, egressPerGb: 0.114 },
  { id: 'ap-northeast-3', name: 'Osaka', lat: 34.69, lng: 135.5, gpus: ['T4'], priceFactor: 1.4, egressPerGb: 0.114 },
  { id: 'ap-northeast-2', name: 'Seoul', lat: 37.57, lng: 126.98, gpus: ['T4', 'A10G'], priceFactor: 1.3, egressPerGb: 0.126 },
  { id: 'ap-east-1', name: 'Hong Kong', lat: 22.32, lng: 114.17, gpus: ['T4', 'A10G'], priceFactor: 1.45, egressPerGb: 0.12 },
  { id: 'ap-south-1', name: 'Mumbai', lat: 19.08, lng: 72.88, gpus: ['T4', 'A10G'], priceFactor: 1.1, egressPerGb: 0.1093 },
  { id: 'us-east-1', name: 'N. Virginia', lat: 38.95, lng: -77.45, gpus: ['T4', 'A10G'], priceFactor: 1.0, egressPerGb: 0.09 },
  { id: 'us-west-2', name: 'Oregon', lat: 45.84, lng: -119.7, gpus: ['T4', 'A10G'], priceFactor: 1.0, egressPerGb: 0.09 },
  { id: 'us-west-1', name: 'N. California', lat: 37.35, lng: -121.96, gpus: ['T4'], priceFactor: 1.2, egressPerGb: 0.09 },
  { id: 'eu-west-1', name: 'Ireland', lat: 53.35, lng: -6.26, gpus: ['T4', 'A10G'], priceFactor: 1.12, egressPerGb: 0.09 },
  { id: 'eu-central-1', name: 'Frankfurt', lat: 50.11, lng: 8.68, gpus: ['T4', 'A10G'], priceFactor: 1.25, egressPerGb: 0.09 },
  // Every other commercial region AWS runs, 2026. "(opt-in)" regions must be
  // switched on per account first (the Regions page shows "Not enabled" with
  // the fix). The newest regions start with few instance types: the Regions
  // page asks AWS live which of our GPU machines are sold in each region and
  // shows "Not sold here" / "only T4" where these lists are too hopeful.
  { id: 'us-east-2', name: 'Ohio', lat: 40.0, lng: -83.0, gpus: ['T4', 'A10G'], priceFactor: 1.0, egressPerGb: 0.09 },
  { id: 'ca-central-1', name: 'Montréal', lat: 45.5, lng: -73.57, gpus: ['T4', 'A10G'], priceFactor: 1.1, egressPerGb: 0.09 },
  { id: 'ca-west-1', name: 'Calgary', lat: 51.05, lng: -114.07, gpus: ['T4'], priceFactor: 1.15, egressPerGb: 0.09 },                  // opt-in
  { id: 'mx-central-1', name: 'Querétaro (Mexico)', lat: 20.59, lng: -100.39, gpus: ['T4'], priceFactor: 1.2, egressPerGb: 0.09 },       // opt-in
  { id: 'sa-east-1', name: 'São Paulo', lat: -23.55, lng: -46.63, gpus: ['T4', 'A10G'], priceFactor: 1.6, egressPerGb: 0.15 },
  { id: 'eu-west-2', name: 'London', lat: 51.51, lng: -0.13, gpus: ['T4', 'A10G'], priceFactor: 1.15, egressPerGb: 0.09 },
  { id: 'eu-west-3', name: 'Paris', lat: 48.86, lng: 2.35, gpus: ['T4'], priceFactor: 1.18, egressPerGb: 0.09 },
  { id: 'eu-north-1', name: 'Stockholm', lat: 59.33, lng: 18.07, gpus: ['T4', 'A10G'], priceFactor: 1.05, egressPerGb: 0.09 },
  { id: 'eu-south-1', name: 'Milan', lat: 45.46, lng: 9.19, gpus: ['T4'], priceFactor: 1.2, egressPerGb: 0.09 },                        // opt-in
  { id: 'eu-south-2', name: 'Spain (Aragón)', lat: 41.65, lng: -0.88, gpus: ['T4'], priceFactor: 1.15, egressPerGb: 0.09 },               // opt-in
  { id: 'eu-central-2', name: 'Zurich', lat: 47.37, lng: 8.54, gpus: ['T4'], priceFactor: 1.3, egressPerGb: 0.09 },                     // opt-in
  { id: 'il-central-1', name: 'Tel Aviv', lat: 32.08, lng: 34.78, gpus: ['T4'], priceFactor: 1.25, egressPerGb: 0.11 },                 // opt-in
  { id: 'me-south-1', name: 'Bahrain', lat: 26.07, lng: 50.56, gpus: ['T4'], priceFactor: 1.3, egressPerGb: 0.117 },                   // opt-in
  { id: 'me-central-1', name: 'UAE (Dubai)', lat: 25.2, lng: 55.27, gpus: ['T4'], priceFactor: 1.3, egressPerGb: 0.11 },                // opt-in
  { id: 'af-south-1', name: 'Cape Town', lat: -33.92, lng: 18.42, gpus: ['T4'], priceFactor: 1.35, egressPerGb: 0.154 },                // opt-in
  { id: 'ap-south-2', name: 'Hyderabad', lat: 17.39, lng: 78.49, gpus: ['T4'], priceFactor: 1.1, egressPerGb: 0.1093 },                 // opt-in
  { id: 'ap-southeast-3', name: 'Jakarta', lat: -6.21, lng: 106.85, gpus: ['T4'], priceFactor: 1.35, egressPerGb: 0.132 },              // opt-in
  { id: 'ap-southeast-4', name: 'Melbourne', lat: -37.81, lng: 144.96, gpus: ['T4'], priceFactor: 1.5, egressPerGb: 0.114 },            // opt-in
  { id: 'ap-southeast-5', name: 'Kuala Lumpur (Malaysia)', lat: 3.14, lng: 101.69, gpus: ['T4'], priceFactor: 1.3, egressPerGb: 0.12 }, // opt-in
  { id: 'ap-southeast-7', name: 'Bangkok (Thailand)', lat: 13.76, lng: 100.5, gpus: ['T4'], priceFactor: 1.3, egressPerGb: 0.12 },     // opt-in
  { id: 'ap-east-2', name: 'Taipei', lat: 25.03, lng: 121.57, gpus: ['T4'], priceFactor: 1.35, egressPerGb: 0.12 },                     // opt-in
];

export const DEFAULT_REGION = 'ap-southeast-1';

/** gp3 disk price, $/GB/month (us-east-1; a little higher in Asia). */
export const GP3_PER_GB_MONTH = 0.096;
/** EBS snapshot storage, $/GB/month (standard tier, approximate). */
export const SNAPSHOT_PER_GB_MONTH = 0.05;

/** Rough spot discount: spot ≈ 35% of on-demand. */
export const SPOT_FACTOR = 0.35;

/**
 * Boot image: Canonical's official Ubuntu 22.04 LTS (the OS our setup
 * script is written for). AMI ids differ per region and change with every
 * Ubuntu update, so we look up the newest one by owner + name each launch.
 * 099720109477 is Canonical's AWS account id.
 */
export const UBUNTU_OWNER = '099720109477';
// Canonical renamed its images in 2024 (gp3 root disks live under
// "hvm-ssd-gp3/"); older images kept the "hvm-ssd/" path. Search both and the
// newest wins, so we never get stuck on a stale image (CloudyPad also uses
// the hvm-ssd-gp3 path).
export const UBUNTU_NAME_PATTERNS = [
  'ubuntu/images/hvm-ssd-gp3/ubuntu-jammy-22.04-amd64-server-*',
  'ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*',
];

export function findShape(id: string): AwsShape | undefined {
  return AWS_SHAPES.find((s) => s.id === id);
}

export function findRegion(id: string): AwsRegion | undefined {
  return AWS_REGIONS.find((r) => r.id === id);
}

/** Estimated $/hour for a shape in a region (0 if the shape is unknown). */
export function estimateHourly(shapeId: string, regionId: string, spot = false): number {
  const shape = findShape(shapeId);
  const region = findRegion(regionId);
  if (!shape) return 0;
  const onDemand = shape.usEastOnDemand * (region?.priceFactor ?? 1.3);
  const price = spot ? onDemand * SPOT_FACTOR : onDemand;
  return Math.round(price * 1000) / 1000; // 3 decimal places
}

// ---------------------------------------------------------------------------
// The generic catalog the launch form reads (see shared/types.ts)
// ---------------------------------------------------------------------------

export const AWS_CATALOG: ProviderCatalog = {
  provider: 'aws',
  label: 'Amazon Web Services',
  supportsSpot: true,
  spotLabel: 'Spot Instance',
  defaultRegion: DEFAULT_REGION,
  defaultDiskGb: 150,
  minDiskGb: 50,
  regions: AWS_REGIONS.map((r) => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, gpus: r.gpus, egressPerGb: r.egressPerGb })),
  shapes: AWS_SHAPES.map((s) => ({ id: s.id, label: s.label, gpuModel: s.gpuModel, vcpus: s.vcpus, memoryGb: s.memoryGb, bestFor: s.bestFor })),
  estimateHourly: (shapeId, regionId, spot) => estimateHourly(shapeId, regionId, spot),
  diskPerGbMonth: GP3_PER_GB_MONTH,
  snapshotPerGbMonth: SNAPSHOT_PER_GB_MONTH,
  restoreAnyRegion: true,
  bigScreen: { available: true, extraPerHour: 0, note: 'AWS\'s own GRID driver build; the licence is included in the machine price. Same GPU quota as normal machines.' },
  priceNote:
    'Estimates from AWS\'s us-east-1 Linux list prices scaled per region (±15%); excludes tax, and data sent to you (~USD 0.09–0.12/GB) is extra. Spot prices move with demand — assumed ~35% of on-demand.',
};
