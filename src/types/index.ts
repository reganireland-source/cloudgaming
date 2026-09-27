// User
export interface User {
  id: string;
  email: string;
  createdAt: Date;
  budgetCap: number | null;
  budgetAlertThreshold: number;
}

// Machine
export interface Machine {
  id: string;
  userId: string;
  provider: 'aws' | 'azure' | 'gcp' | 'oracle';
  region: string;
  instanceType: string;
  instanceId: string; // provider-specific ID
  status: 'running' | 'stopped' | 'snapshotting' | 'migrating' | 'failed';
  costPerHour: number;
  createdAt: Date;
  lastStarted: Date | null;
  snapshotId: string | null;
}

// Snapshot
export interface Snapshot {
  id: string;
  machineId: string;
  provider: string;
  region: string;
  diskSizeGb: number;
  costPerMonth: number;
  tags: string[]; // ['game-library', 'elden-ring', etc.]
  createdAt: Date;
}

// Cost tracking
export interface Cost {
  id: string;
  userId: string;
  machineId: string;
  date: Date;
  computeCost: number;
  egressCost: number;
  storageCost: number;
  provider: string;
}

// Game profile
export interface GameProfile {
  id: string;
  title: string;
  gpuClass: 't4' | 'a10g' | 'l4' | 'a100' | 'h100';
  targetQuality: string; // '1080p-60', '1440p-60', '4K-60'
  gpuVramGb: number;
  cpuVramGb: number;
  fpsCpuBound: boolean;
}

// Streaming quality tier
export interface StreamingQuality {
  name: string;
  resolution: string;
  fps: number;
  bitrateKbps: number;
  gbPerHour: number;
  codec: 'h264' | 'h265';
}

// Region data
export interface RegionData {
  provider: string;
  name: string;
  region: string;
  lat: number;
  lng: number;
  spotPrice: number;
  onDemandPrice: number;
  egressCostPerGb: number;
}

// Cloud credentials (encrypted in DB)
export interface CloudCredentials {
  id: string;
  userId: string;
  provider: string;
  encryptedData: string; // JSON stringified and AES-256 encrypted
  createdAt: Date;
}

// API Responses
export interface RecommendationResult {
  provider: string;
  region: string;
  instanceType: string;
  quality: StreamingQuality;
  latencyMs: number;
  computePerHour: number;
  egressPerHour: number;
  totalPerHour: number;
}

export interface MigrationRequest {
  machineId: string;
  targetProvider: string;
  targetRegion: string;
  targetQuality: StreamingQuality;
}

// JWT Payload
export interface JWTPayload {
  userId: string;
  email: string;
  iat: number;
}

// Error response
export interface APIError {
  code: string;
  message: string;
  details?: unknown;
}
