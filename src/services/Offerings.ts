/**
 * services/Offerings.ts — WHICH GPUS A REGION REALLY SELLS
 *
 * The catalogs' per-region GPU lists come from the clouds' docs and drift.
 * The live region check (RegionAccessService) asks each cloud what it sells
 * where; applyOffering() corrects the catalog IN PLACE (the same arrays the
 * providers, Recon, the launch form and launch validation read) and stores
 * it, and loadOfferings() re-applies the stored corrections at startup.
 */

import { query } from '../config/database';
import { CATALOGS, isProviderName } from '../providers/registry';

/** Replace a catalog region's GPU list (same array object, so every reader sees it). */
function patch(provider: string, regionId: string, gpus: string[]): boolean {
  if (!isProviderName(provider)) return false;
  const region = CATALOGS[provider].regions.find((r) => r.id === regionId);
  if (!region) return false;
  const next = Array.from(new Set(gpus)).sort();
  if ([...region.gpus].sort().join(',') === next.join(',')) return false;
  region.gpus.splice(0, region.gpus.length, ...next);
  return true;
}

/** Record what the cloud said it sells in this region (from a live check). */
export async function applyOffering(provider: string, regionId: string, gpus: string[]): Promise<void> {
  const changed = patch(provider, regionId, gpus);
  if (changed) console.log(`[Offerings] ${provider} ${regionId} sells: ${gpus.join(', ') || 'none of our GPUs'} (catalog corrected)`);
  await query(
    `INSERT INTO gpu_offerings (provider, region, gpus, checked_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (provider, region) DO UPDATE SET gpus = EXCLUDED.gpus, checked_at = NOW()`,
    [provider, regionId, gpus],
  ).catch(() => undefined);
}

/** At startup: re-apply what earlier checks learned. */
export async function loadOfferings(): Promise<void> {
  try {
    const rows = (await query('SELECT provider, region, gpus FROM gpu_offerings')).rows;
    const n = rows.filter((r: any) => patch(r.provider, r.region, r.gpus || [])).length;
    if (n) console.log(`[Offerings] ${n} region GPU list${n === 1 ? '' : 's'} corrected from earlier live checks`);
  } catch {
    /* table not there yet (migrations run first) or DB down: keep the catalog */
  }
}
