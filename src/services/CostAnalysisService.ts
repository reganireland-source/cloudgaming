import { query } from '../config/database';

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

interface CostComparison {
  instanceType: string;
  quality: string;
  usageHours: number;
  estimatedDataOutGb: number;
  snapshots: Array<{
    sizeGb: number;
    durationMonths: number;
  }>;
  regions: RegionCost[];
  recommendation: {
    bestValue: RegionCost;
    fastestLatency: RegionCost;
    cheapest: RegionCost;
    reasoning: string;
  };
}

interface PerformanceMetric {
  provider: string;
  region: string;
  avgLatencyMs: number;
  p99LatencyMs: number;
  packetLossPercent: number;
  availabilityPercent: number;
  throughputMbps: number;
  uptime99_9Percent: boolean;
}

// Pricing data (in USD) - Updated periodically
interface RegionPricing {
  egressPerGb: number;
  snapshotPerGbMonth: number;
  [instanceType: string]: number;
}

const PRICING_DATA: Record<string, Record<string, RegionPricing>> = {
  aws: {
    'ap-southeast-1': {
      'g4dn.xlarge': 0.526,
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

const QUALITY_DATA_EGRESS = {
  budget: 2.25, // GB per hour (720p 30fps 5Mbps)
  good: 5.4, // GB per hour (1080p 60fps 12Mbps)
  high: 11.25, // GB per hour (1440p 60fps 25Mbps)
  ultra: 22.5, // GB per hour (4K 60fps 50Mbps)
};

export class CostAnalysisService {
  /**
   * Compare costs across regions and providers
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

    const egressPerHour = QUALITY_DATA_EGRESS[quality as keyof typeof QUALITY_DATA_EGRESS] || 5.4;
    const estimatedDataOutGb = egressPerHour * usageHoursPerMonth;

    const regions: RegionCost[] = [];

    // Calculate costs for each available region
    for (const provider of providers) {
      const providerData = PRICING_DATA[provider as keyof typeof PRICING_DATA];
      if (!providerData) continue;

      for (const region of Object.keys(providerData)) {
        const regionData = providerData[region as keyof typeof providerData];
        if (!regionData) continue;

        const instanceCost = regionData[instanceType as keyof typeof regionData];
        if (!instanceCost) continue;

        const computeCost = instanceCost * usageHoursPerMonth;
        const egressCost = (regionData.egressPerGb || 0.09) * estimatedDataOutGb;
        const snapshotCost = (regionData.snapshotPerGbMonth || 0.05) * snapshotSizeGb;
        const totalMonthlyCost = computeCost + egressCost + snapshotCost;

        // Get performance data
        const performanceKey = `${provider}-${region}`;
        let latency = 50; // Default fallback
        const allMetrics = Object.values(PERFORMANCE_DATA).flat();
        const metric = allMetrics.find(
          m => m.provider === provider && m.region === region
        );
        if (metric) {
          latency = metric.avgLatencyMs;
        }

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

    // Sort by cost
    const sortedByPrice = [...regions].sort((a, b) => a.totalMonthlyCost - b.totalMonthlyCost);
    const sortedByLatency = [...regions].sort((a, b) => a.latencyMs - b.latencyMs);

    // Calculate best value (balances cost and performance)
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
        fastestLatency: sortedByLatency[0],
        cheapest: sortedByPrice[0],
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
   */
  static calculateSavings(baseMonthlyCost: number, commitmentMonths: number): {
    onDemandCost: number;
    committedCost: number;
    savings: number;
    savingsPercent: number;
  } {
    const onDemandCost = baseMonthlyCost * commitmentMonths;
    // Typical cloud discounts: 1-yr 25%, 3-yr 40%
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
    const hoursPerMonth = hoursPerWeek * 4.33; // Average weeks per month

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
