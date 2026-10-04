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

export type AccessStatus = 'ready' | 'no-quota' | 'not-enabled' | 'not-offered' | 'unknown' | 'not-connected';

export interface QuotaLine { label: string; limit: number; used: number; unit: 'GPUs' | 'vCPUs' }

export interface RegionAccess {
  region: string; name: string; lat: number; lng: number;
  status: AccessStatus;
  summary: string;
  quotas: QuotaLine[];
  spot: QuotaLine | null;
  spotReady: boolean | null;
  onDemandReady?: boolean | null; // false = only spot machines can launch here
  missingGpus?: string[];   // ready, except for these GPU models (GCP: T4 vs L4 quota)
  notSold?: string[];       // GPU models the cloud doesn't sell in this region at all
  fix?: { steps: string[]; consoleUrl?: string; consoleLabel?: string; cli?: string };
  /** "What can I run here": each tier × normal / spot / big screen. */
  run?: RunRow[];
  /** Every quota that matters here, what it unlocks, and open increase requests. */
  quotaDetail?: QuotaDetail[];
  pendingNote?: string;
}

export type RunMode = 'normal' | 'spot' | 'big' | 'bigSpot';
export const RUN_MODES: Array<{ id: RunMode; label: string; short: string }> = [
  { id: 'normal', label: 'Normal', short: 'Normal' },
  { id: 'spot', label: 'Spot', short: 'Spot' },
  { id: 'big', label: 'Big screen', short: 'Big' },
  { id: 'bigSpot', label: 'Big screen + spot', short: 'Big+spot' },
];
export interface RunCell { ok: boolean | null; na?: boolean; inUse?: boolean; why: string; uses?: string[] }

/** Nothing can launch right now, but you do have quota here: your own machines are using it (stop one to launch another). */
export function quotaInUse(a: RegionAccess): boolean {
  if (a.status !== 'no-quota' || !a.run) return false;
  return a.run.some((r) => Object.values(r.cells).some((c) => c.ok === false && c.inUse));
}
export interface RunRow { tier: 'good' | 'better' | 'best' | 'super'; label: string; shape: string; cells: Record<RunMode, RunCell> }
export interface PendingRequest { requested: number; status: string; created?: string }
export interface QuotaDetail {
  key: string; label: string; used: number | null; limit: number; unit: 'GPUs' | 'vCPUs'; unlocks: string[]; pending?: PendingRequest[];
  /** Not enough left for even the smallest machine that uses it. */
  short?: boolean;
  /** How to ask for more: console page + one-line command. */
  request?: { consoleUrl?: string; consoleLabel?: string; cli?: string; note?: string };
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
export function statusFor(a: RegionAccess, gpuModel?: string, spot?: boolean): AccessStatus {
  if (gpuModel && a.notSold?.includes(gpuModel)) return 'not-offered';
  // Spot and on-demand have separate quotas: a "spot only" region is no-quota for an on-demand machine.
  if (a.status === 'ready' && spot === false && a.onDemandReady === false) return 'no-quota';
  if (a.status === 'ready' && spot === true && a.spotReady === false) return 'no-quota';
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
  'not-offered': { icon: '⊘', label: 'GPU not sold here', short: 'Not sold', className: 'border-white/20 text-slate-400 bg-white/[0.02]' },
  unknown: { icon: '?', label: 'Couldn’t check', short: 'Unchecked', className: 'border-white/25 text-slate-300' },
  'not-connected': { icon: '–', label: 'Cloud not connected', short: 'No keys', className: 'border-white/15 text-slate-500' },
};

export interface CheckLine { i: number; ms: number; level: 'info' | 'call' | 'ok' | 'warn' | 'err'; text: string }

/** Run the check with a live log: onLines gets each batch of new log lines. */
export async function runRegionCheck(refresh: boolean, onLines: (lines: CheckLine[]) => void): Promise<AccessReport> {
  const { checkId } = await apiFetch<{ checkId: string }>('/regions/access/check', { method: 'POST', body: { refresh } });
  let after = 0;
  for (;;) {
    const r = await apiFetch<{ done: boolean; lines: CheckLine[]; result?: AccessReport; error?: string }>(`/regions/access/check/${checkId}?after=${after}`);
    if (r.lines.length) { after = r.lines[r.lines.length - 1].i; onLines(r.lines); }
    if (r.done) {
      if (!r.result) throw new Error(r.error || 'The check failed.');
      return r.result;
    }
    await new Promise((res) => setTimeout(res, 350));
  }
}

/** Every quota request on one cloud, any outcome (GET /api/regions/quota-requests). */
export type RequestState = 'open' | 'approved' | 'partial' | 'denied' | 'cancelled';
export interface QuotaRequestRecord {
  id: string; region: string; key: string; label: string; requested: number; granted: number | null;
  state: RequestState; status: string; created?: string; updated?: string;
}
export interface QuotaRequestHistory { provider: string; readable: boolean; note?: string; requests: QuotaRequestRecord[]; checkedAt: string }
export const fetchQuotaRequests = (provider: string) =>
  apiFetch<QuotaRequestHistory>(`/regions/quota-requests?provider=${encodeURIComponent(provider)}`);
