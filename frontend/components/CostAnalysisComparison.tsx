'use client';

import { useState, useEffect } from 'react';

interface RegionOption {
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

interface Recommendation {
  bestValue: RegionOption;
  fastestLatency: RegionOption;
  cheapest: RegionOption;
  reasoning: string;
}

interface CostAnalysis {
  instanceType: string;
  quality: string;
  usageHours: number;
  estimatedDataOutGb: number;
  regions: RegionOption[];
  recommendation: Recommendation;
}

interface CostAnalysisComparisonProps {
  instanceType?: string;
  quality?: string;
  usageHoursPerMonth?: number;
  snapshotSizeGb?: number;
}

export default function CostAnalysisComparison({
  instanceType = 'g4dn.xlarge',
  quality = 'good',
  usageHoursPerMonth = 100,
  snapshotSizeGb = 100,
}: CostAnalysisComparisonProps) {
  const [analysis, setAnalysis] = useState<CostAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

  useEffect(() => {
    const fetchAnalysis = async () => {
      try {
        const response = await fetch('/api/cost-analysis/compare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instanceType,
            quality,
            usageHoursPerMonth,
            snapshotSizeGb,
          }),
        });
        const data = await response.json();
        setAnalysis(data);
        setSelectedProvider(data.recommendation.bestValue.provider);
      } catch (error) {
        console.error('Failed to fetch cost analysis:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchAnalysis();
  }, [instanceType, quality, usageHoursPerMonth, snapshotSizeGb]);

  if (loading) {
    return (
      <div className="p-8 text-center">
        <div className="inline-block">
          <div className="animate-spin h-8 w-8 border-2 border-neon-cyan border-t-transparent rounded-full mb-4"></div>
          <p className="font-mono text-neon-cyan text-sm">
            > ANALYZING_COSTS_AND_PERFORMANCE...
          </p>
        </div>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="p-8 text-center">
        <p className="font-mono text-neon-pink">
          > ERROR_LOADING_ANALYSIS
        </p>
      </div>
    );
  }

  const getBadge = (region: RegionOption): string | null => {
    if (
      region.provider === analysis.recommendation.bestValue.provider &&
      region.region === analysis.recommendation.bestValue.region
    ) {
      return 'RECOMMENDED';
    }
    if (
      region.provider === analysis.recommendation.cheapest.provider &&
      region.region === analysis.recommendation.cheapest.region
    ) {
      return 'CHEAPEST';
    }
    if (
      region.provider === analysis.recommendation.fastestLatency.provider &&
      region.region === analysis.recommendation.fastestLatency.region
    ) {
      return 'FASTEST';
    }
    return null;
  };

  const getBadgeColor = (badge: string | null) => {
    switch (badge) {
      case 'RECOMMENDED':
        return 'bg-neon-lime text-slate-900';
      case 'CHEAPEST':
        return 'bg-neon-cyan text-slate-900';
      case 'FASTEST':
        return 'bg-neon-magenta text-slate-900';
      default:
        return '';
    }
  };

  return (
    <div className="space-y-6">
      {/* Recommendation Box */}
      <div className="p-6 rounded-lg border-2 border-neon-lime/50 bg-green-950/20">
        <h3 className="font-bold font-mono text-neon-lime mb-2 text-lg">
          [ RECOMMENDATION ]
        </h3>
        <p className="font-mono text-gray-300 text-sm mb-3">
          {analysis.recommendation.reasoning}
        </p>
        <div className="flex items-center gap-2 p-3 rounded bg-slate-900/50 border border-neon-lime/30">
          <span className="text-xl">✓</span>
          <span className="font-mono text-neon-lime font-bold">
            {analysis.recommendation.bestValue.provider.toUpperCase()} •{' '}
            {analysis.recommendation.bestValue.region} • $
            {analysis.recommendation.bestValue.totalMonthlyCost}/mo
          </span>
        </div>
      </div>

      {/* Cost Breakdown */}
      <div className="p-6 rounded-lg border-2 border-neon-cyan/30 bg-cyan-950/20">
        <h3 className="font-bold font-mono text-neon-cyan mb-4">[ PARAMETERS ]</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs font-mono">
          <div>
            <p className="text-gray-400">INSTANCE</p>
            <p className="text-neon-lime font-bold">{instanceType}</p>
          </div>
          <div>
            <p className="text-gray-400">QUALITY</p>
            <p className="text-neon-lime font-bold">{quality.toUpperCase()}</p>
          </div>
          <div>
            <p className="text-gray-400">HOURS/MONTH</p>
            <p className="text-neon-lime font-bold">{usageHoursPerMonth}</p>
          </div>
          <div>
            <p className="text-gray-400">DATA OUT</p>
            <p className="text-neon-lime font-bold">
              {Math.round(analysis.estimatedDataOutGb)} GB
            </p>
          </div>
        </div>
      </div>

      {/* Region Comparison Table */}
      <div className="overflow-x-auto">
        <div className="neon-card rounded-lg border-2 border-neon-cyan overflow-hidden">
          <table className="w-full font-mono text-sm">
            <thead className="border-b-2 border-neon-cyan/30 bg-cyan-950/20">
              <tr>
                <th className="px-4 py-3 text-left text-neon-cyan font-bold">
                  [PROVIDER / REGION]
                </th>
                <th className="px-4 py-3 text-right text-neon-magenta font-bold">
                  [COMPUTE]
                </th>
                <th className="px-4 py-3 text-right text-neon-pink font-bold">
                  [EGRESS]
                </th>
                <th className="px-4 py-3 text-right text-neon-lime font-bold">
                  [TOTAL/MO]
                </th>
                <th className="px-4 py-3 text-right text-neon-cyan font-bold">
                  [LATENCY]
                </th>
                <th className="px-4 py-3 text-center text-neon-lime font-bold">
                  [STATUS]
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neon-cyan/20">
              {analysis.regions.map((region, idx) => {
                const badge = getBadge(region);
                const isRecommended =
                  region.provider === analysis.recommendation.bestValue.provider &&
                  region.region === analysis.recommendation.bestValue.region;

                return (
                  <tr
                    key={idx}
                    className={`${
                      isRecommended
                        ? 'bg-green-950/20 border-l-2 border-neon-lime'
                        : 'hover:bg-cyan-950/10'
                    } transition-colors`}
                  >
                    <td className="px-4 py-3">
                      <div className="text-neon-cyan font-bold">
                        {region.provider.toUpperCase()}
                      </div>
                      <div className="text-gray-400 text-xs">{region.region}</div>
                    </td>
                    <td className="px-4 py-3 text-right text-neon-magenta">
                      ${region.computeCost}
                    </td>
                    <td className="px-4 py-3 text-right text-neon-pink">
                      ${region.egressCost}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-bold text-lg text-neon-lime">
                        ${region.totalMonthlyCost}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-neon-cyan">
                      {region.latencyMs}ms
                    </td>
                    <td className="px-4 py-3 text-center">
                      {badge && (
                        <span
                          className={`inline-block px-2 py-1 rounded text-xs font-bold ${getBadgeColor(
                            badge
                          )}`}
                        >
                          {badge}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Cost vs Performance Trade-off */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Cheapest */}
        <div className="p-4 rounded-lg border-2 border-neon-cyan/30 bg-cyan-950/20">
          <p className="text-xs font-mono text-gray-400 mb-2">CHEAPEST_OPTION</p>
          <p className="font-bold text-neon-cyan mb-1">
            {analysis.recommendation.cheapest.provider.toUpperCase()}
          </p>
          <p className="text-xs text-gray-300 mb-2">
            {analysis.recommendation.cheapest.region}
          </p>
          <p className="text-lg font-bold text-neon-lime">
            ${analysis.recommendation.cheapest.totalMonthlyCost}/mo
          </p>
          <p className="text-xs text-gray-400 mt-2">
            Latency: {analysis.recommendation.cheapest.latencyMs}ms
          </p>
        </div>

        {/* Fastest */}
        <div className="p-4 rounded-lg border-2 border-neon-magenta/30 bg-magenta-950/20">
          <p className="text-xs font-mono text-gray-400 mb-2">FASTEST_LATENCY</p>
          <p className="font-bold text-neon-magenta mb-1">
            {analysis.recommendation.fastestLatency.provider.toUpperCase()}
          </p>
          <p className="text-xs text-gray-300 mb-2">
            {analysis.recommendation.fastestLatency.region}
          </p>
          <p className="text-lg font-bold text-neon-magenta">
            {analysis.recommendation.fastestLatency.latencyMs}ms
          </p>
          <p className="text-xs text-gray-400 mt-2">
            Cost: ${analysis.recommendation.fastestLatency.totalMonthlyCost}/mo
          </p>
        </div>

        {/* Best Value */}
        <div className="p-4 rounded-lg border-2 border-neon-lime/30 bg-green-950/20">
          <p className="text-xs font-mono text-gray-400 mb-2">BEST_VALUE</p>
          <p className="font-bold text-neon-lime mb-1">
            {analysis.recommendation.bestValue.provider.toUpperCase()}
          </p>
          <p className="text-xs text-gray-300 mb-2">
            {analysis.recommendation.bestValue.region}
          </p>
          <p className="text-lg font-bold text-neon-lime">
            ${analysis.recommendation.bestValue.totalMonthlyCost}/mo
          </p>
          <p className="text-xs text-gray-400 mt-2">
            Latency: {analysis.recommendation.bestValue.latencyMs}ms
          </p>
        </div>
      </div>

      {/* Cost Insights */}
      <div className="p-4 rounded-lg border border-neon-cyan/30 bg-slate-900/50 text-xs font-mono space-y-2">
        <p className="text-gray-400">
          ℹ Costs include compute, data egress, and snapshot storage for {snapshotSizeGb}GB
        </p>
        <p className="text-gray-400">
          ℹ Latency is estimated based on typical cloud provider SLAs
        </p>
        <p className="text-neon-lime">
          💡 Tip: Save {Math.round((analysis.recommendation.cheapest.totalMonthlyCost - analysis.recommendation.bestValue.totalMonthlyCost) * 100) / 100 > 0 ? Math.round((analysis.recommendation.cheapest.totalMonthlyCost - analysis.recommendation.bestValue.totalMonthlyCost) * 100) / 100 : 0}$/mo
          with recommended region vs cheapest, while maintaining better latency
        </p>
      </div>
    </div>
  );
}
