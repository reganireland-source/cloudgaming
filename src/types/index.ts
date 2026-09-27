/**
 * ============================================================================
 * src/types/index.ts — THE SHAPES OF OUR DATA
 * ============================================================================
 *
 * WHAT THIS FILE IS
 * -----------------
 * TypeScript lets us describe what an object looks like — which fields it
 * has and what type each field is. These descriptions are called INTERFACES.
 * They exist only while compiling: they catch mistakes like typos in field
 * names or putting text where a number belongs, then vanish completely from
 * the JavaScript that actually runs.
 *
 * Syntax reminders:
 *   field: string              the field must be text
 *   field: number | null       a number, or deliberately empty
 *   field?: string             the field may be missing entirely
 *   'aws' | 'azure'            only these exact text values are allowed
 *
 * ONE THING TO KNOW (a known inconsistency)
 * -----------------------------------------
 * These interfaces use camelCase (instanceType), but the database uses
 * snake_case columns (instance_type). Rows returned straight from Postgres
 * therefore have snake_case keys and don't match these interfaces exactly.
 * That's why much of the service code treats raw database rows as `any`
 * rather than as these types.
 * ============================================================================
 */

// A person with an account.
export interface User {
  id: string;
  email: string;
  createdAt: Date;
  budgetCap: number | null;       // optional monthly spending limit, in dollars
  budgetAlertThreshold: number;   // % of the cap at which to warn (e.g. 80)
}

// A gaming virtual machine (VM) running on one of the clouds.
export interface Machine {
  id: string;                     // OUR id for the machine
  userId: string;                 // who owns it
  provider: 'aws' | 'azure' | 'gcp' | 'oracle';
  region: string;                 // e.g. 'ap-southeast-1' (Singapore)
  instanceType: string;           // the hardware size, e.g. 'g4dn.xlarge'
  instanceId: string;             // the CLOUD PROVIDER's own id for it (e.g. AWS's 'i-0abc...')
  status: 'running' | 'stopped' | 'snapshotting' | 'migrating' | 'failed';
  costPerHour: number;            // dollars per hour while running
  createdAt: Date;
  lastStarted: Date | null;
  snapshotId: string | null;      // latest backup of this machine's disk, if any
}

// A saved copy (backup) of a machine's disk. Lets you delete an expensive
// machine but keep its installed games, and restore them later — even in a
// different region or cloud.
export interface Snapshot {
  id: string;
  machineId: string;
  provider: string;
  region: string;
  diskSizeGb: number;
  costPerMonth: number;           // storage cost for keeping this backup
  tags: string[];                 // free labels, e.g. ['game-library', 'elden-ring']
  createdAt: Date;
}

// One day's spend for one machine, split into the three kinds of cost.
export interface Cost {
  id: string;
  userId: string;
  machineId: string;
  date: Date;
  computeCost: number;            // paying for the machine to run
  egressCost: number;             // paying for data sent OUT of the cloud (the video stream!)
  storageCost: number;            // paying for disks and snapshots
  provider: string;
}

// How demanding a particular game is, so we can recommend suitable hardware.
export interface GameProfile {
  id: string;
  title: string;
  gpuClass: 't4' | 'a10g' | 'l4' | 'a100' | 'h100'; // NVIDIA GPU models, weakest to strongest
  targetQuality: string;          // e.g. '1080p-60', '1440p-60', '4K-60'
  gpuVramGb: number;              // graphics memory the game needs
  cpuVramGb: number;
  fpsCpuBound: boolean;           // true if frame rate is limited by the CPU rather than the GPU
}

// A streaming quality preset (resolution + frame rate + bitrate).
export interface StreamingQuality {
  name: string;
  resolution: string;
  fps: number;                    // frames per second
  bitrateKbps: number;            // video data rate, in kilobits per second
  gbPerHour: number;              // how much data an hour of play sends (drives egress cost)
  codec: 'h264' | 'h265';         // video compression format; h265 is more efficient
}

// A cloud region with its location and prices.
export interface RegionData {
  provider: string;
  name: string;
  region: string;
  lat: number;                    // latitude/longitude — used to estimate network latency to the player
  lng: number;
  spotPrice: number;              // cheap "spare capacity" price (can be interrupted)
  onDemandPrice: number;          // normal, guaranteed price
  egressCostPerGb: number;
}

// A user's saved login details for one cloud provider.
// NOTE: the comment below describes the intended design. Encryption is NOT
// implemented yet — values are currently stored as plain JSON text.
export interface CloudCredentials {
  id: string;
  userId: string;
  provider: string;
  encryptedData: string; // JSON stringified and AES-256 encrypted
  createdAt: Date;
}

// ---- Shapes of API responses/requests ------------------------------------

// One suggested setup returned by the recommendation engine.
export interface RecommendationResult {
  provider: string;
  region: string;
  instanceType: string;
  quality: StreamingQuality;
  latencyMs: number;              // estimated network delay to the player, in milliseconds
  computePerHour: number;
  egressPerHour: number;
  totalPerHour: number;
}

// A request to move a machine to another region or cloud.
export interface MigrationRequest {
  machineId: string;
  targetProvider: string;
  targetRegion: string;
  targetQuality: StreamingQuality;
}

// The data stored inside a login token (see src/api/middleware/auth.ts).
export interface JWTPayload {
  userId: string;
  email: string;
  iat: number;                    // "issued at" — when the token was created (seconds since 1970)
}

// A standard error response body.
export interface APIError {
  code: string;
  message: string;
  details?: unknown;              // `unknown` = could be anything; must be checked before use
}
