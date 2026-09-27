/**
 * ============================================================================
 * src/services/CostAnalysisService.ts — ESTIMATING MONTHLY COST PER REGION
 * ============================================================================
 *
 * Answers "if I play like THIS, what would each cloud/region cost me per
 * month, and which should I pick?" — the maths behind the Cost Comparison
 * table on the frontend.
 *
 * THE COST MODEL (three parts, per month)
 * ---------------------------------------
 *   compute  = machine price per hour × hours played
 *   egress   = data streamed out (GB) × price per GB
 *              data out = GB-per-hour for the quality × hours played
 *   snapshot = snapshot size (GB) × storage price per GB-month
 *   total    = compute + egress + snapshot
 *
 * All figures come from the HARD-CODED tables below (PRICING_DATA,
 * PERFORMANCE_DATA) — estimates typed in by hand, not live prices. Nothing
 * here touches the database or network, so every function is synchronous
 * (no `async`/`await`).
 *
 * ⚠️  KNOWN LIMITATIONS
 * --------------------
 * 1. Not really cross-cloud yet: each cloud names its machines differently
 *    (AWS 'g4dn.xlarge', Azure 'Standard_NV6', GCP 'n1-standard-4-...'), and
 *    analyzeCosts only includes regions that list the EXACT instanceType
 *    asked for. So asking about 'g4dn.xlarge' only ever compares AWS
 *    regions. A mapping of "equivalent" machines across clouds is needed.
 * 2. If NO region matches the instance type, `regions` is empty and
 *    `regions.reduce(...)` with no starting value throws a TypeError.
 * 3. In generateRecommendation's last branch, "savings" = cheapest −
 *    bestValue, which is ≤ 0 (the cheapest is by definition cheapest), so the
 *    message can read "Save $-4.2/mo". The claim "latency under 50ms" isn't
 *    checked either.
 * 4. Every region reports availability as a fixed 99.95%.
 * ============================================================================
 */

import { query } from '../config/database'; // imported but unused — everything here is in-memory

/** One region's monthly cost estimate (a row in the comparison table). */
interface RegionCost {
  provider: string;
  region: string;
  instanceType: string;
  computeCost: number;
  egressCost: number;
  snapshotCost: number;
  totalMonthlyCost: number;
  latencyMs: number;
  availabilityPercent: number;
}

/** The full answer from analyzeCosts. */
interface CostComparison {
  instanceType: string;
  quality: string;
  usageHours: number;
  estimatedDataOutGb: number;
  snapshots: Array<{            // Array<X> is the same as X[]
    sizeGb: number;
    durationMonths: number;
  }>;
  regions: RegionCost[];        // sorted cheapest first
  recommendation: {
    bestValue: RegionCost;      // best cost × latency trade-off
    fastestLatency: RegionCost;
    cheapest: RegionCost;
    reasoning: string;          // a sentence explaining the pick
  };
}

/** Estimated network quality figures for one region. */
interface PerformanceMetric {
  provider: string;
  region: string;
  avgLatencyMs: number;         // typical delay
  p99LatencyMs: number;         // "99th percentile": 99% of the time it's at least this fast
  packetLossPercent: number;    // % of network packets lost (causes stutter)
  availabilityPercent: number;  // % of time the service is up
  throughputMbps: number;       // network capacity
  uptime99_9Percent: boolean;
}

// Pricing data (in USD) - Updated periodically (by hand)
//
// Shape of one region's entry: fixed fields egressPerGb and
// snapshotPerGbMonth, plus one entry per machine type giving its hourly
// price. `[instanceType: string]: number` is an "index signature": ANY
// other string key is allowed, and its value must be a number.
interface RegionPricing {
  egressPerGb: number;
  snapshotPerGbMonth: number;
  [instanceType: string]: number;
}

// PRICING_DATA[provider][region] -> RegionPricing.
// The explicit type annotation matters: without it TypeScript infers each
// provider's slightly different shape separately, and looking up a region
// by a variable name gets typed as `never` — a build error we hit earlier.
const PRICING_DATA: Record<string, Record<string, RegionPricing>> = {
  aws: {
    'ap-southeast-1': {
      'g4dn.xlarge': 0.526,       // $/hour
      egressPerGb: 0.114, // Singapore
      snapshotPerGbMonth: 0.05,
    },
    'us-east-1': {
      'g4dn.xlarge': 0.526,
      egressPerGb: 0.09,
      snapshotPerGbMonth: 0.05,
    },
    'eu-west-1': {
      'g4dn.xlarge': 0.563,
      egressPerGb: 0.09,
      snapshotPerGbMonth: 0.05,
    },
  },
  azure: {
    eastus: {
      'Standard_NV6': 0.45,
      egressPerGb: 0.087,
      snapshotPerGbMonth: 0.05,
    },
    'southeastasia': {
      'Standard_NV6': 0.504,
      egressPerGb: 0.12,
      snapshotPerGbMonth: 0.05,
    },
  },
  gcp: {
    'us-central1': {
      'n1-standard-4-gpu-1x-a100': 0.35,
      egressPerGb: 0.12,
      snapshotPerGbMonth: 0.026,
    },
    'asia-southeast1': {
      'n1-standard-4-gpu-1x-a100': 0.44,
      egressPerGb: 0.12,
      snapshotPerGbMonth: 0.026,
    },
  },
};

// Performance metrics (estimated, based on cloud provider benchmarks)
// Keyed by machine type, then a list of regions. Regions not listed here
// fall back to a 50 ms latency guess in analyzeCosts.
const PERFORMANCE_DATA: Record<string, PerformanceMetric[]> = {
  'g4dn.xlarge': [
    {
      provider: 'aws',
      region: 'ap-southeast-1',
      avgLatencyMs: 28,
      p99LatencyMs: 45,
      packetLossPercent: 0.02,
      availabilityPercent: 99.95,
      throughputMbps: 950,
      uptime99_9Percent: true,
    },
    {
      provider: 'aws',
      region: 'us-east-1',
      avgLatencyMs: 15,
      p99LatencyMs: 35,
      packetLossPercent: 0.01,
      availabilityPercent: 99.99,
      throughputMbps: 1000,
      uptime99_9Percent: true,
    },
  ],
  'Standard_NV6': [
    {
      provider: 'azure',
      region: 'eastus',
      avgLatencyMs: 12,
      p99LatencyMs: 30,
      packetLossPercent: 0.01,
      availabilityPercent: 99.99,
      throughputMbps: 980,
      uptime99_9Percent: true,
    },
    {
      provider: 'azure',
      region: 'southeastasia',
      avgLatencyMs: 32,
      p99LatencyMs: 50,
      packetLossPercent: 0.02,
      availabilityPercent: 99.95,
      throughputMbps: 950,
      uptime99_9Percent: true,
    },
  ],
};

// GB of video data sent per hour of play, per quality preset.
// Formula: Mbps × 3600 seconds ÷ 8 (bits per byte) ÷ 1000 (MB per GB).
// e.g. 25 Mbps × 3600 ÷ 8 ÷ 1000 = 11.25 GB/hour.
const QUALITY_DATA_EGRESS = {
  budget: 2.25, // GB per hour (720p 30fps 5Mbps)
  good: 5.4, // GB per hour (1080p 60fps 12Mbps)
  high: 11.25, // GB per hour (1440p 60fps 25Mbps)
  ultra: 22.5, // GB per hour (4K 60fps 50Mbps)
};

export class CostAnalysisService {
  /**
   * Compare costs across regions and providers
   *
   * For every region (of the requested providers) that offers the requested
   * machine type, compute the monthly cost; then pick the cheapest, the
   * lowest-latency, and the best overall value.
   * ⚠️ See Known Limitations 1 and 2.
   */
  static analyzeCosts(params: {
    instanceType: string;
    quality: string;
    usageHoursPerMonth: number;
    snapshotSizeGb?: number;
    providers?: string[];
  }): CostComparison {
    const {
      instanceType,
      quality,
      usageHoursPerMonth,
      snapshotSizeGb = 100,
      providers = ['aws', 'azure', 'gcp'],
    } = params;

    // Data per hour for this quality; unknown quality -> 'good' (5.4 GB/h).
    // `quality as keyof typeof QUALITY_DATA_EGRESS` tells TypeScript to
    // treat the text as one of the table's keys ('budget' | 'good' | ...).
    const egressPerHour = QUALITY_DATA_EGRESS[quality as keyof typeof QUALITY_DATA_EGRESS] || 5.4;
    const estimatedDataOutGb = egressPerHour * usageHoursPerMonth;

    const regions: RegionCost[] = [];

    // Two nested loops: every provider, then every region of that provider.
    for (const provider of providers) {
      const providerData = PRICING_DATA[provider as keyof typeof PRICING_DATA];
      if (!providerData) continue; // unknown provider: skip it

      for (const region of Object.keys(providerData)) {
        const regionData = providerData[region as keyof typeof providerData];
        if (!regionData) continue;

        // Hourly price of this machine type here. Missing = this region
        // doesn't offer it (e.g. asking Azure about 'g4dn.xlarge') -> skip.
        const instanceCost = regionData[instanceType as keyof typeof regionData];
        if (!instanceCost) continue;

        // The three cost parts (see file header).
        const computeCost = instanceCost * usageHoursPerMonth;
        const egressCost = (regionData.egressPerGb || 0.09) * estimatedDataOutGb;
        const snapshotCost = (regionData.snapshotPerGbMonth || 0.05) * snapshotSizeGb;
        const totalMonthlyCost = computeCost + egressCost + snapshotCost;

        // Latency: use the estimate from PERFORMANCE_DATA if this region has
        // one, else a 50 ms default. `.flat()` merges the per-machine-type
        // lists into one big list so we can search all of them.
        const performanceKey = `${provider}-${region}`; // (unused)
        let latency = 50; // Default fallback
        const allMetrics = Object.values(PERFORMANCE_DATA).flat();
        const metric = allMetrics.find(
          m => m.provider === provider && m.region === region
        );
        if (metric) {
          latency = metric.avgLatencyMs;
        }

        // Math.round(x * 100) / 100 rounds to 2 decimal places (cents).
        regions.push({
          provider,
          region,
          instanceType,
          computeCost: Math.round(computeCost * 100) / 100,
          egressCost: Math.round(egressCost * 100) / 100,
          snapshotCost: Math.round(snapshotCost * 100) / 100,
          totalMonthlyCost: Math.round(totalMonthlyCost * 100) / 100,
          latencyMs: latency,
          availabilityPercent: 99.95,
        });
      }
    }

    // Two sorted copies. `[...regions]` makes a COPY first, because .sort()
    // rearranges the array it's called on. The compare function returns
    // negative/zero/positive to say which of two items comes first; a − b
    // gives smallest first.
    const sortedByPrice = [...regions].sort((a, b) => a.totalMonthlyCost - b.totalMonthlyCost);
    const sortedByLatency = [...regions].sort((a, b) => a.latencyMs - b.latencyMs);

    // "Best value": score = (cost ÷ 100) × (latency ÷ 10); LOWER is better,
    // so it rewards being both cheap and fast. `reduce` walks the list
    // keeping whichever region has scored best so far.
    // ⚠️ Throws if `regions` is empty (Known Limitation 2).
    const bestValue = regions.reduce((best, current) => {
      const bestScore = (best.totalMonthlyCost / 100) * (best.latencyMs / 10);
      const currentScore = (current.totalMonthlyCost / 100) * (current.latencyMs / 10);
      return currentScore < bestScore ? current : best;
    });

    return {
      instanceType,
      quality,
      usageHours: usageHoursPerMonth,
      estimatedDataOutGb,
      snapshots: [{ sizeGb: snapshotSizeGb, durationMonths: 1 }],
      regions: sortedByPrice,
      recommendation: {
        bestValue,
        fastestLatency: sortedByLatency[0], // first = lowest latency
        cheapest: sortedByPrice[0],         // first = cheapest
        reasoning: this.generateRecommendation(
          sortedByPrice[0],
          sortedByLatency[0],
          bestValue,
          quality
        ),
      },
    };
  }

  /**
   * Get performance metrics for a region
   * @returns the figures, or null if we have none for that combination
   */
  static getPerformanceMetrics(
    instanceType: string,
    provider: string,
    region: string
  ): PerformanceMetric | null {
    const metrics = PERFORMANCE_DATA[instanceType] || [];
    return metrics.find(m => m.provider === provider && m.region === region) || null;
  }

  /**
   * Calculate cost savings for multi-month commitments
   *
   * Clouds discount you for committing to pay for 1 or 3 years ("reserved
   * instances" / "savings plans"). Uses rough typical discounts: 12+ months
   * = 25% off, 36+ months = 40% off, shorter = no discount.
   * e.g. $100/month for 12 months: $1200 on-demand -> $900 committed, save $300 (25%).
   */
  static calculateSavings(baseMonthlyCost: number, commitmentMonths: number): {
    onDemandCost: number;
    committedCost: number;
    savings: number;
    savingsPercent: number;
  } {
    const onDemandCost = baseMonthlyCost * commitmentMonths;
    // Typical cloud discounts: 1-yr 25%, 3-yr 40%
    // (A "ternary" chain: condition ? valueIfTrue : valueIfFalse.)
    const discountPercent = commitmentMonths >= 36 ? 0.4 : commitmentMonths >= 12 ? 0.25 : 0;
    const committedCost = onDemandCost * (1 - discountPercent);

    return {
      onDemandCost: Math.round(onDemandCost * 100) / 100,
      committedCost: Math.round(committedCost * 100) / 100,
      savings: Math.round((onDemandCost - committedCost) * 100) / 100,
      savingsPercent: Math.round(discountPercent * 100),
    };
  }

  /**
   * Estimate monthly cost for a machine based on usage patterns
   *
   * Same cost model as analyzeCosts but for ONE provider/region, with usage
   * given per WEEK (× 4.33, the average number of weeks in a month) and a
   * snapshot size fixed at 100 GB. Returns zeros for unknown provider/region.
   */
  static estimateMachineMonthly(params: {
    provider: string;
    region: string;
    instanceType: string;
    quality: string;
    hoursPerWeek: number;
  }): {
    estimate: number;
    breakdown: {
      compute: number;
      egress: number;
      snapshot: number;
    };
  } {
    const { provider, region, instanceType, quality, hoursPerWeek } = params;

    const providerData = PRICING_DATA[provider as keyof typeof PRICING_DATA];
    if (!providerData) {
      return { estimate: 0, breakdown: { compute: 0, egress: 0, snapshot: 0 } };
    }

    const regionData = providerData[region as keyof typeof providerData];
    if (!regionData) {
      return { estimate: 0, breakdown: { compute: 0, egress: 0, snapshot: 0 } };
    }

    const instanceCost = regionData[instanceType as keyof typeof regionData] || 0;
    const hoursPerMonth = hoursPerWeek * 4.33; // Average weeks per month (52 ÷ 12)

    const computeCost = instanceCost * hoursPerMonth;

    const egressPerHour = QUALITY_DATA_EGRESS[quality as keyof typeof QUALITY_DATA_EGRESS] || 5.4;
    const totalDataOutGb = egressPerHour * hoursPerMonth;
    const egressCost = (regionData.egressPerGb || 0.09) * totalDataOutGb;

    const snapshotCost = (regionData.snapshotPerGbMonth || 0.05) * 100; // Assuming 100GB snapshot

    const estimate = computeCost + egressCost + snapshotCost;

    return {
      estimate: Math.round(estimate * 100) / 100,
      breakdown: {
        compute: Math.round(computeCost * 100) / 100,
        egress: Math.round(egressCost * 100) / 100,
        snapshot: Math.round(snapshotCost * 100) / 100,
      },
    };
  }

  /**
   * Write the one-sentence explanation shown with the recommendation.
   * Three cases: best value is also the cheapest; best value is also the
   * fastest; or it's a trade-off between them.
   * ⚠️ See Known Limitation 3 about the "Save $…" figure.
   * (`$${x}` in a template string = a literal "$" followed by the value of x.)
   */
  private static generateRecommendation(
    cheapest: RegionCost,
    fastest: RegionCost,
    bestValue: RegionCost,
    quality: string
  ): string {
    let recommendation = '';

    if (cheapest.provider === bestValue.provider && cheapest.region === bestValue.region) {
      recommendation = `Recommended: ${cheapest.provider.toUpperCase()} ${cheapest.region} - Best cost ($${cheapest.totalMonthlyCost}/mo) with excellent performance (${cheapest.latencyMs}ms latency).`;
    } else if (fastest.provider === bestValue.provider && fastest.region === bestValue.region) {
      recommendation = `Recommended: ${bestValue.provider.toUpperCase()} ${bestValue.region} - Fastest latency (${fastest.latencyMs}ms) at reasonable cost ($${bestValue.totalMonthlyCost}/mo).`;
    } else {
      const savings =
        cheapest.totalMonthlyCost - bestValue.totalMonthlyCost;
      recommendation = `Recommended: ${bestValue.provider.toUpperCase()} ${bestValue.region} - Best balance of cost and performance. Save $${savings}/mo vs ${cheapest.provider.toUpperCase()} while keeping latency under 50ms.`;
    }

    if (quality === 'ultra') {
      recommendation += ` Note: Ultra quality ${quality} requires stable high-bandwidth connections.`;
    }

    return recommendation;
  }
}
