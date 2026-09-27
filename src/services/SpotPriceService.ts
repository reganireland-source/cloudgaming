/**
 * ============================================================================
 * src/services/SpotPriceService.ts — HOW CHEAP IS SPOT RIGHT NOW, AND HOW RISKY?
 * ============================================================================
 *
 * "Spot" (AWS / GCP / Azure) or "preemptible" (Oracle) machines are spare
 * capacity sold at a big discount. The catch: the cloud can take the machine
 * back at short notice when it needs the hardware. This service answers, per
 * cloud + region + machine size:
 *
 *   spotPerHour    $/hour on spot
 *   discountPct    how much cheaper than on-demand (0–100)
 *   source         'live'      read from the cloud's public data just now
 *                  'fixed'     the cloud sets a fixed discount (Oracle: 50%)
 *                  'estimate'  our catalog's assumption (no public live feed)
 *   interruption   how often the cloud reclaims this size here, when the
 *                  cloud publishes it (AWS only): e.g. '<5%' … '>20%'
 *   onReclaim      what happens to the machine when it's taken back
 *
 * Live sources (no login or keys needed; cached, and any failure falls back
 * to the catalog estimate so the page never breaks):
 *   AWS    Spot Instance Advisor data — the feed behind
 *          https://aws.amazon.com/ec2/spot/instance-advisor/ : savings vs
 *          on-demand and the interruption-frequency band, per region and
 *          instance type (Linux). Refreshed hourly.
 *   Azure  Retail Prices API — https://prices.azure.com/api/retail/prices :
 *          the Linux pay-as-you-go and Spot meters for each size/region.
 *          Refreshed every 6 hours.
 *   GCP    No unauthenticated price feed (the Cloud Billing Catalog API needs
 *          an API key); Google moves spot prices at most once a month, 60–91%
 *          off. We use the catalog's conservative 60%.
 *   Oracle Preemptible is always exactly 50% off.
 * ============================================================================
 */

import { CATALOGS } from '../providers/registry';
import type { ProviderName } from '../providers/shared/types';

export interface SpotInfo {
  spotPerHour: number;
  onDemandPerHour: number;
  discountPct: number;
  source: 'live' | 'fixed' | 'estimate';
  interruption: { label: string; level: number } | null; // level 0 (rare) … 4 (frequent)
  onReclaim: string;
}

// What each cloud does to OUR machines when it reclaims them (see the
// providers' launch code: AWS persistent+stop, GCP STOP, Azure Deallocate,
// Oracle TERMINATE).
export const ON_RECLAIM: Record<ProviderName, string> = {
  aws: 'AWS stops it (2-minute warning); your disk and games are kept — start it again when capacity returns.',
  gcp: 'Google stops it (30-second warning); your disk and games are kept.',
  azure: 'Azure stops it (30-second warning); your disk and games are kept.',
  oracle: 'Oracle deletes it, including its disk — you start again from scratch.',
};

// ---------------------------------------------------------------------------
// AWS: Spot Instance Advisor feed (≈1 MB JSON; cached 1 hour)
// ---------------------------------------------------------------------------
const AWS_ADVISOR_URL = 'https://spot-bid-advisor.s3.amazonaws.com/spot-advisor-data.json';
let awsAdvisor: { at: number; data?: any; pending?: Promise<void> } = { at: 0 };

async function loadAwsAdvisor(): Promise<any | undefined> {
  if (awsAdvisor.data && Date.now() - awsAdvisor.at < 3_600_000) return awsAdvisor.data;
  if (!awsAdvisor.pending) {
    awsAdvisor.pending = (async () => {
      try {
        const res = await fetch(AWS_ADVISOR_URL, { signal: AbortSignal.timeout(8000) });
        if (res.ok) awsAdvisor = { at: Date.now(), data: (await res.json()) as any };
        else awsAdvisor.at = Date.now() - 3_300_000; // retry in ~5 minutes
      } catch (error) {
        console.error('[Spot] AWS advisor feed unavailable:', (error as Error).message);
        awsAdvisor.at = Date.now() - 3_300_000;
      } finally {
        awsAdvisor.pending = undefined;
      }
    })();
  }
  await awsAdvisor.pending;
  return awsAdvisor.data;
}

// ---------------------------------------------------------------------------
// Azure: Retail Prices API (cached 6 hours per size + region)
// ---------------------------------------------------------------------------
const azureCache = new Map<string, { at: number; onDemand?: number; spot?: number }>();

async function azurePrices(armSku: string, region: string): Promise<{ onDemand?: number; spot?: number }> {
  const key = `${armSku}|${region}`;
  const hit = azureCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit;
  const filter = `serviceName eq 'Virtual Machines' and armSkuName eq '${armSku}' and armRegionName eq '${region}' and priceType eq 'Consumption'`;
  try {
    const res = await fetch(`https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items: any[] = ((await res.json()) as any).Items || [];
    // Linux meters only (our machines run Ubuntu); hourly; skip Low Priority.
    const linux = items.filter((i) => !/windows/i.test(i.productName) && i.unitOfMeasure === '1 Hour' && !/low priority/i.test(i.skuName));
    const spot = linux.find((i) => /\bspot\b/i.test(i.skuName))?.retailPrice;
    const onDemand = linux.find((i) => !/\bspot\b/i.test(i.skuName))?.retailPrice;
    const entry = { at: Date.now(), onDemand: onDemand || undefined, spot: spot || undefined };
    azureCache.set(key, entry);
    return entry;
  } catch (error) {
    console.error(`[Spot] Azure price lookup failed (${armSku} ${region}):`, (error as Error).message);
    azureCache.set(key, { at: Date.now() - 5.5 * 3_600_000 }); // retry in ~30 minutes
    return {};
  }
}

const AWS_BANDS = ['<5%', '5–10%', '10–15%', '15–20%', '>20%'];
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Spot price, discount and risk for one machine size in one region.
 * Returns null when the cloud has no spot option.
 */
export async function getSpotInfo(provider: ProviderName, regionId: string, shapeId: string): Promise<SpotInfo | null> {
  const catalog = CATALOGS[provider];
  if (!catalog?.supportsSpot) return null;
  const estOnDemand = catalog.estimateHourly(shapeId, regionId, false);
  const estSpot = catalog.estimateHourly(shapeId, regionId, true);
  if (!estOnDemand || !estSpot) return null;
  const fallback: SpotInfo = {
    spotPerHour: estSpot, onDemandPerHour: estOnDemand,
    discountPct: Math.round((1 - estSpot / estOnDemand) * 100),
    source: provider === 'oracle' ? 'fixed' : 'estimate',
    interruption: null, onReclaim: ON_RECLAIM[provider],
  };

  if (provider === 'aws') {
    // Our AWS shape ids ARE instance types (e.g. 'g4dn.xlarge').
    const row = (await loadAwsAdvisor())?.spot_advisor?.[regionId]?.Linux?.[shapeId];
    if (row && Number.isFinite(row.s)) {
      return {
        ...fallback,
        spotPerHour: round3(estOnDemand * (1 - row.s / 100)),
        discountPct: row.s,
        source: 'live',
        interruption: Number.isFinite(row.r) ? { label: AWS_BANDS[row.r] || '?', level: row.r } : null,
      };
    }
    return fallback;
  }

  if (provider === 'azure') {
    // Our Azure shape ids ARE VM size names (e.g. 'Standard_NC4as_T4_v3').
    const p = await azurePrices(shapeId, regionId);
    if (p.spot && p.onDemand) {
      return { ...fallback, spotPerHour: round3(p.spot), onDemandPerHour: round3(p.onDemand), discountPct: Math.round((1 - p.spot / p.onDemand) * 100), source: 'live' };
    }
    return fallback;
  }

  return fallback; // gcp (estimate), oracle (fixed 50%)
}

/** Warm the AWS feed at startup so the first Recon page is fast. */
export function prewarmSpotPrices(): void {
  loadAwsAdvisor().catch(() => undefined);
}
