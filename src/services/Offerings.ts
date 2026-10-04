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

/** Rows stored before the `checked` column only asked about these models. */
const LEGACY_CHECKED = ['T4', 'L4', 'A10G', 'A10'];

/**
 * Update a catalog region's GPU list (same array object, so every reader sees
 * it): the models the check asked about follow its answer; any other model
 * (added to the app since) keeps the catalog's value.
 */
function patch(provider: string, regionId: string, gpus: string[], checked: string[]): boolean {
  if (!isProviderName(provider)) return false;
  const region = CATALOGS[provider].regions.find((r) => r.id === regionId);
  if (!region) return false;
  const next = Array.from(new Set([...region.gpus.filter((g) => !checked.includes(g)), ...gpus])).sort();
  if ([...region.gpus].sort().join(',') === next.join(',')) return false;
  region.gpus.splice(0, region.gpus.length, ...next);
  return true;
}

/** Record what the cloud said it sells in this region (from a live check). */
export async function applyOffering(provider: string, regionId: string, gpus: string[], checked: string[]): Promise<void> {
  const changed = patch(provider, regionId, gpus, checked);
  if (changed) console.log(`[Offerings] ${provider} ${regionId} sells: ${gpus.join(', ') || 'none of our GPUs'} (catalog corrected)`);
  await query(
    `INSERT INTO gpu_offerings (provider, region, gpus, checked, checked_at) VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (provider, region) DO UPDATE SET gpus = EXCLUDED.gpus, checked = EXCLUDED.checked, checked_at = NOW()`,
    [provider, regionId, gpus, checked],
  ).catch(() => undefined);
}

/** At startup: re-apply what earlier checks learned. */
export async function loadOfferings(): Promise<void> {
  try {
    const rows = (await query('SELECT provider, region, gpus, checked FROM gpu_offerings')).rows;
    const n = rows.filter((r: any) => patch(r.provider, r.region, r.gpus || [], r.checked || LEGACY_CHECKED)).length;
    if (n) console.log(`[Offerings] ${n} region GPU list${n === 1 ? '' : 's'} corrected from earlier live checks`);
  } catch {
    /* table not there yet (migrations run first) or DB down: keep the catalog */
  }
}
