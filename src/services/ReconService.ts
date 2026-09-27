/**
 * ============================================================================
 * src/services/ReconService.ts — "WHERE SHOULD I PLAY, AND ON WHAT?"
 * ============================================================================
 *
 * Feeds the Recon page. Given where the player is (lat/lng — the page turns a
 * city or country into coordinates first), it ranks every cloud region the
 * app can launch in, separately for three hardware tiers:
 *
 *   GOOD    T4-class GPU          → 1080p60   indie, esports, older AAA
 *   BETTER  L4 / A10G, 4 vCPU     → 1440p60   modern AAA
 *   BEST    L4 / A10G, 8+ vCPU,   → 1440p–4K  demanding AAA, CPU-heavy games
 *           or Oracle's A10 VM
 *
 * Everything comes from the same catalogs the launch form uses
 * (src/providers/<cloud>/catalog.ts), so a recommendation can be launched
 * exactly as shown. Per tier, per region, the cheapest machine shape of that
 * tier is picked, then:
 *   - latency  = distance estimate (same formula as the infrastructure map)
 *   - cost/h   = machine price (on-demand, or spot if asked) + data sent to
 *                the player (the tier's streaming quality in GB/h × the
 *                region's egress price)
 * and options are ranked by latency band first (anything under ~30 ms feels
 * the same), then by price.
 *
 * If a game title is given and found in game_profiles, its gpu_class picks
 * the suggested tier. No login or cloud keys are needed: this only reads the
 * price catalogs.
 * ============================================================================
 */

import { query } from '../config/database';
import { CATALOGS } from '../providers/registry';
import type { CatalogShape, ProviderName } from '../providers/shared/types';

export type TierId = 'good' | 'better' | 'best';

// Streaming quality per tier; GB/h matches the streaming_qualities seed data.
export const TIERS: Array<{
  id: TierId; label: string; gpuClass: string; gpuShort: string; resolution: string; fps: number; gbPerHour: number; bestFor: string;
}> = [
  { id: 'good', label: 'Good', gpuClass: 'NVIDIA T4', gpuShort: 'T4', resolution: '1080p', fps: 60, gbPerHour: 3.6,
    bestFor: 'Indie, esports and older AAA games' },
  { id: 'better', label: 'Better', gpuClass: 'NVIDIA L4 / A10G', gpuShort: 'L4 · A10G', resolution: '1440p', fps: 60, gbPerHour: 5.4,
    bestFor: 'Modern AAA games' },
  { id: 'best', label: 'Best', gpuClass: 'NVIDIA L4 / A10G / A10 with 8+ vCPU', gpuShort: 'A10 · 8+ CPU', resolution: '4K', fps: 60, gbPerHour: 9,
    bestFor: 'Demanding AAA and CPU-heavy games' },
];

/** Which tier a catalog shape belongs to. */
export function tierOf(shape: CatalogShape): TierId {
  if (shape.gpuModel === 'T4') return 'good';                       // T4 with 8 vCPU is still a T4
  if (shape.gpuModel === 'A10') return 'best';                      // Oracle's A10 VM: 30 vCPU, 240 GB
  return shape.vcpus >= 8 ? 'best' : 'better';                      // L4 / A10G
}

// game_profiles.gpu_class → suggested tier
const GAME_TIER: Record<string, TierId> = { t4: 'good', a10g: 'better', a100: 'best', h100: 'best' };

/** Same estimate as the map (frontend/components/InfraMap.tsx estimatePingMs). */
export function estimatePingMs(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  return Math.round(5 + km * 0.015);
}

function rating(ms: number): 'excellent' | 'good' | 'fair' | 'poor' {
  return ms <= 30 ? 'excellent' : ms <= 50 ? 'good' : ms <= 80 ? 'fair' : 'poor';
}
const BAND = { excellent: 0, good: 1, fair: 2, poor: 3 };

export interface ReconOption {
  provider: ProviderName;
  providerLabel: string;
  region: string;
  regionName: string;
  shapeId: string;
  shapeLabel: string;
  gpuModel: string;
  vcpus: number;
  memoryGb: number;
  latencyMs: number;
  latencyRating: 'excellent' | 'good' | 'fair' | 'poor';
  computePerHour: number;   // on-demand or spot, whichever was asked for (and offered)
  spot: boolean;            // true when computePerHour is a spot price
  spotLabel: string;
  egressPerHour: number;
  totalPerHour: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export async function recon(opts: { lat: number; lng: number; budgetPerHour?: number; spot?: boolean; gameTitle?: string; limit?: number }) {
  const limit = opts.limit ?? 6;

  // Game → suggested tier (optional; the page still works if the DB is down).
  let game: { title: string; gpuClass: string; suggestedTier: TierId } | null = null;
  let gameNotFound = false;
  let games: string[] = [];
  try {
    games = (await query(`SELECT title FROM game_profiles ORDER BY title`)).rows.map((r: any) => r.title);
    if (opts.gameTitle?.trim()) {
      const g = await query(`SELECT title, gpu_class FROM game_profiles WHERE title ILIKE $1 LIMIT 1`, [`%${opts.gameTitle.trim()}%`]);
      if (g.rows[0]) game = { title: g.rows[0].title, gpuClass: g.rows[0].gpu_class, suggestedTier: GAME_TIER[g.rows[0].gpu_class] || 'better' };
      else gameNotFound = true;
    }
  } catch (error) {
    console.error('[Recon] game lookup failed:', (error as Error).message);
  }

  const tiers = TIERS.map((tier) => {
    const all: ReconOption[] = [];
    const offeredBy = new Set<string>();
    for (const catalog of Object.values(CATALOGS)) {
      const shapes = catalog.shapes.filter((s) => tierOf(s) === tier.id);
      if (shapes.length) offeredBy.add(catalog.label);
      for (const region of catalog.regions) {
        let best: ReconOption | null = null;
        for (const shape of shapes) {
          if (!region.gpus.includes(shape.gpuModel)) continue;
          const onDemand = catalog.estimateHourly(shape.id, region.id, false);
          const spotPrice = opts.spot && catalog.supportsSpot ? catalog.estimateHourly(shape.id, region.id, true) : 0;
          const useSpot = spotPrice > 0;
          const compute = useSpot ? spotPrice : onDemand;
          if (!compute) continue;
          const egress = tier.gbPerHour * region.egressPerGb;
          const latencyMs = estimatePingMs(opts.lat, opts.lng, region.lat, region.lng);
          const option: ReconOption = {
            provider: catalog.provider, providerLabel: catalog.label,
            region: region.id, regionName: region.name,
            shapeId: shape.id, shapeLabel: shape.label, gpuModel: shape.gpuModel, vcpus: shape.vcpus, memoryGb: shape.memoryGb,
            latencyMs, latencyRating: rating(latencyMs),
            computePerHour: round3(compute), spot: useSpot, spotLabel: catalog.spotLabel,
            egressPerHour: round3(egress), totalPerHour: round3(compute + egress),
          };
          if (!best || option.totalPerHour < best.totalPerHour) best = option;
        }
        if (best) all.push(best);
      }
    }
    all.sort((a, b) => BAND[a.latencyRating] - BAND[b.latencyRating] || a.totalPerHour - b.totalPerHour || a.latencyMs - b.latencyMs);
    const affordable = opts.budgetPerHour ? all.filter((o) => o.totalPerHour <= opts.budgetPerHour!) : all;
    // Laggy regions (> 80 ms) only pad the list when fewer than 3 others fit.
    const playable = affordable.filter((o) => o.latencyRating !== 'poor');
    const shown = (playable.length >= 3 ? playable : affordable.slice(0, Math.max(3, playable.length))).slice(0, limit);
    const closest = [...all].sort((a, b) => a.latencyMs - b.latencyMs)[0] || null;
    // "Cheapest" among regions you could actually play on (≤ 80 ms), if any.
    const pool = all.some((o) => o.latencyRating !== 'poor') ? all.filter((o) => o.latencyRating !== 'poor') : all;
    const cheapest = [...pool].sort((a, b) => a.totalPerHour - b.totalPerHour)[0] || null;
    return {
      ...tier,
      options: shown,
      totalOptions: all.length,
      overBudget: all.length - affordable.length,
      tooFar: affordable.filter((o) => o.latencyRating === 'poor' && !shown.includes(o)).length,
      closest,
      cheapest,
      offeredBy: [...offeredBy],
      notOfferedBy: Object.values(CATALOGS).map((c) => c.label).filter((l) => !offeredBy.has(l)),
    };
  });

  return { location: { lat: opts.lat, lng: opts.lng }, spot: !!opts.spot, budgetPerHour: opts.budgetPerHour ?? null, game, gameNotFound, games, tiers };
}
