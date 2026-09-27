/**
 * ============================================================================
 * lib/regionAccess.ts — "CAN I LAUNCH HERE?" PER CLOUD REGION
 * ============================================================================
 *
 * Reads GET /api/regions/access: for every cloud and every region the app
 * supports, whether your account can launch a GPU machine there — quota,
 * region switched on, keys connected — and what to do if not. The backend
 * asks each cloud directly (quota APIs) and caches for 10 minutes; pass
 * refresh to force a re-check.
 *
 * Used by the Regions page, the Recon list (badge per option) and the
 * launch form (note under the region picker).
 * ============================================================================
 */

import { apiFetch, type FriendlyError } from './auth';

export type AccessStatus = 'ready' | 'no-quota' | 'not-enabled' | 'unknown' | 'not-connected';

export interface QuotaLine { label: string; limit: number; used: number; unit: 'GPUs' | 'vCPUs' }

export interface RegionAccess {
  region: string; name: string; lat: number; lng: number;
  status: AccessStatus;
  summary: string;
  quotas: QuotaLine[];
  spot: QuotaLine | null;
  spotReady: boolean | null;
  missingGpus?: string[];   // ready, except for these GPU models (GCP: T4 vs L4 quota)
  fix?: { steps: string[]; consoleUrl?: string; consoleLabel?: string; cli?: string };
}

export interface CloudAccess {
  provider: string; label: string; connected: boolean;
  error?: FriendlyError;
  regions: RegionAccess[];
  checkedAt: string;
}

export interface AccessReport { generatedAt: string; clouds: CloudAccess[] }

export const fetchRegionAccess = (refresh = false) =>
  apiFetch<AccessReport>(`/regions/access${refresh ? '?refresh=true' : ''}`);

/** Status for one GPU model: a region that's ready for T4 but has no L4 quota is "no quota" for an L4 machine. */
export function statusFor(a: RegionAccess, gpuModel?: string): AccessStatus {
  return a.status === 'ready' && gpuModel && a.missingGpus?.includes(gpuModel) ? 'no-quota' : a.status;
}

/** provider:region → access, for quick lookups from Recon / launch. */
export function indexAccess(report: AccessReport | null): Record<string, RegionAccess> {
  const out: Record<string, RegionAccess> = {};
  for (const c of report?.clouds || []) for (const r of c.regions) out[`${c.provider}:${r.region}`] = r;
  return out;
}

// Status → chip. Icon + word, never colour alone.
export const ACCESS_STYLE: Record<AccessStatus, { icon: string; label: string; short: string; className: string }> = {
  ready: { icon: '✓', label: 'Ready', short: 'Ready', className: 'border-neon-lime/60 text-neon-lime bg-neon-lime/[0.06]' },
  'no-quota': { icon: '!', label: 'No GPU quota', short: 'No quota', className: 'border-neon-amber/60 text-neon-amber bg-neon-amber/[0.06]' },
  'not-enabled': { icon: '✗', label: 'Region not enabled', short: 'Not enabled', className: 'border-neon-pink/60 text-neon-pink bg-neon-pink/[0.06]' },
  unknown: { icon: '?', label: 'Couldn’t check', short: 'Unchecked', className: 'border-white/25 text-slate-300' },
  'not-connected': { icon: '–', label: 'Cloud not connected', short: 'No keys', className: 'border-white/15 text-slate-500' },
};
