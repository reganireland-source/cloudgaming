import https from 'https';
import { query } from '../config/database';

export interface ServiceStatus {
  name: string;
  connected: boolean;
  latencyMs?: number;
  detail?: string;
  checkedAt: string;
}

export interface SystemStatus {
  backend: ServiceStatus;
  database: ServiceStatus;
  providers: {
    aws: ServiceStatus;
    azure: ServiceStatus;
    gcp: ServiceStatus;
    oracle: ServiceStatus;
  };
}

// Lightweight, unauthenticated reachability probes - these check that the
// backend has a network path to each cloud's public endpoint, not that any
// particular user's credentials are valid. A machine doesn't need to be
// running on a provider for its light to be relevant to check.
const PROVIDER_PROBES: Record<'aws' | 'azure' | 'gcp' | 'oracle', string> = {
  aws: 'https://ec2.amazonaws.com',
  azure: 'https://management.azure.com',
  gcp: 'https://compute.googleapis.com',
  oracle: 'https://cloud.oracle.com',
};

const PROBE_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 15000;

let cache: { data: SystemStatus; expiresAt: number } | null = null;

function probeUrl(url: string): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = https.request(url, { method: 'HEAD', timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve({ ok: true, latencyMs: Date.now() - start });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, latencyMs: Date.now() - start, detail: 'timeout' });
    });

    req.on('error', (err) => {
      // Cloud endpoints often reject a bare HEAD with 4xx/connection reset,
      // but that still proves the network path is reachable - only a hard
      // connection failure (DNS, refused, timeout) counts as "down" here.
      resolve({ ok: false, latencyMs: Date.now() - start, detail: err.message });
    });

    req.end();
  });
}

async function checkDatabase(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await query('SELECT 1');
    return {
      name: 'database',
      connected: true,
      latencyMs: Date.now() - start,
      checkedAt: new Date().toISOString(),
    };
  } catch (error: any) {
    return {
      name: 'database',
      connected: false,
      latencyMs: Date.now() - start,
      detail: error.message || String(error),
      checkedAt: new Date().toISOString(),
    };
  }
}

async function checkProvider(
  name: 'aws' | 'azure' | 'gcp' | 'oracle'
): Promise<ServiceStatus> {
  const url = PROVIDER_PROBES[name];
  try {
    const result = await probeUrl(url);
    // ok is true as soon as any HTTP response comes back, even a 4xx -
    // that still proves the network path is reachable. Only a genuine
    // connection failure (DNS, refused, reset, timeout) is "down".
    return {
      name,
      connected: result.ok,
      latencyMs: result.latencyMs,
      detail: result.detail,
      checkedAt: new Date().toISOString(),
    };
  } catch (error: any) {
    return {
      name,
      connected: false,
      detail: error.message || String(error),
      checkedAt: new Date().toISOString(),
    };
  }
}

export async function getSystemStatus(forceRefresh = false): Promise<SystemStatus> {
  if (!forceRefresh && cache && cache.expiresAt > Date.now()) {
    return cache.data;
  }

  const [database, aws, azure, gcp, oracle] = await Promise.all([
    checkDatabase(),
    checkProvider('aws'),
    checkProvider('azure'),
    checkProvider('gcp'),
    checkProvider('oracle'),
  ]);

  const data: SystemStatus = {
    backend: {
      name: 'backend',
      connected: true,
      checkedAt: new Date().toISOString(),
    },
    database,
    providers: { aws, azure, gcp, oracle },
  };

  cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}
