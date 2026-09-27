'use client';

import { useState } from 'react';

interface Recommendation {
  provider: string;
  region: string;
  instanceType: string;
  quality: { name: string; resolution: string; fps: number };
  latencyMs: number;
  computePerHour: number;
  egressPerHour: number;
  totalPerHour: number;
}

export default function RecommendationsPage() {
  const [gameTitle, setGameTitle] = useState('');
  const [userLat, setUserLat] = useState('1.3521');
  const [userLng, setUserLng] = useState('103.8198');
  const [budget, setBudget] = useState('');
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(false);

  const mockRecommendations: Recommendation[] = [
    {
      provider: 'aws',
      region: 'us-east-1',
      instanceType: 'g4dn.xlarge',
      quality: { name: 'High', resolution: '1440p', fps: 60 },
      latencyMs: 85,
      computePerHour: 0.526,
      egressPerHour: 0.432,
      totalPerHour: 0.958,
    },
    {
      provider: 'oracle',
      region: 'ap-singapore-1',
      instanceType: 'VM.GPU2.1',
      quality: { name: 'High', resolution: '1440p', fps: 60 },
      latencyMs: 15,
      computePerHour: 0.4,
      egressPerHour: 0,
      totalPerHour: 0.4,
    },
    {
      provider: 'azure',
      region: 'eastasia',
      instanceType: 'Standard_NV6',
      quality: { name: 'Good', resolution: '1080p', fps: 60 },
      latencyMs: 25,
      computePerHour: 0.45,
      egressPerHour: 0.36,
      totalPerHour: 0.81,
    },
  ];

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    // Simulate API call
    setTimeout(() => {
      const filtered = budget
        ? mockRecommendations.filter(r => r.totalPerHour <= parseFloat(budget))
        : mockRecommendations;

      setRecommendations(filtered);
      setLoading(false);
    }, 1000);
  };

  const handleSetMyLocation = () => {
    // In production, use browser geolocation
    setUserLat('1.3521');
    setUserLng('103.8198');
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-bold neon-text mb-2 font-mono">[ GAME_RECON ]</h1>
        <p className="font-mono text-neon-lime text-sm">
          {'> find_optimal_region_and_instance_for_location_budget'.toUpperCase()}
        </p>
      </div>

      {/* Search Form */}
      <form onSubmit={handleSearch} className="neon-card rounded-lg p-6 mb-8 border border-neon-cyan/30">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-bold text-neon-cyan mb-2 font-mono">GAME_TITLE</label>
            <input
              type="text"
              value={gameTitle}
              onChange={(e) => setGameTitle(e.target.value)}
              placeholder="Elden_Ring"
              className="input-neon w-full px-4 py-2 rounded font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-neon-cyan mb-2 font-mono">LATITUDE</label>
            <input
              type="number"
              step="0.0001"
              value={userLat}
              onChange={(e) => setUserLat(e.target.value)}
              className="input-neon w-full px-4 py-2 rounded font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-neon-cyan mb-2 font-mono">LONGITUDE</label>
            <input
              type="number"
              step="0.0001"
              value={userLng}
              onChange={(e) => setUserLng(e.target.value)}
              className="input-neon w-full px-4 py-2 rounded font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-neon-cyan mb-2 font-mono">BUDGET_$/HR</label>
            <input
              type="number"
              step="0.01"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="optional"
              className="input-neon w-full px-4 py-2 rounded font-mono text-sm"
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={loading}
            className="btn-neon-cyan disabled:opacity-50 disabled:cursor-not-allowed font-mono"
          >
            {loading ? '[ SEARCHING... ]' : '[ RECOMMEND ]'}
          </button>
          <button
            type="button"
            onClick={handleSetMyLocation}
            className="btn-neon-magenta font-mono"
          >
            [ USE_LOCATION ]
          </button>
        </div>
      </form>

      {/* Recommendations */}
      {recommendations.length > 0 ? (
        <div className="space-y-4">
          {recommendations.map((rec, idx) => (
            <div key={idx} className={`rounded-lg p-6 transition border ${idx === 0 ? 'neon-card-magenta border-neon-magenta' : 'neon-card border-neon-cyan'}`}>
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-center">
                <div>
                  <h3 className={`font-bold text-lg font-mono ${idx === 0 ? 'text-neon-magenta' : 'text-neon-cyan'}`}>{rec.provider.toUpperCase()}</h3>
                  <p className="text-xs text-neon-lime font-mono">{rec.region}</p>
                  <p className="text-xs text-neon-cyan/60 mt-1 font-mono">{rec.instanceType}</p>
                </div>

                <div>
                  <p className="text-xs text-neon-cyan/70 mb-1 font-mono font-bold">QUALITY</p>
                  <p className="font-bold text-neon-magenta font-mono">{rec.quality.name}</p>
                  <p className="text-xs text-neon-lime font-mono">{rec.quality.resolution}@{rec.quality.fps}fps</p>
                </div>

                <div>
                  <p className="text-xs text-neon-cyan/70 mb-1 font-mono font-bold">LATENCY</p>
                  <p className="text-2xl font-bold text-neon-pink font-mono">{rec.latencyMs}ms</p>
                  <p className="text-xs text-neon-lime mt-1 font-mono">{rec.latencyMs < 30 ? '✓_Excellent' : rec.latencyMs < 60 ? '⚠_Good' : '⚠_Fair'}</p>
                </div>

                <div className={`rounded p-4 border ${idx === 0 ? 'border-neon-magenta/50' : 'border-neon-cyan/50'}`}>
                  <p className="text-xs text-neon-cyan/70 mb-2 font-mono font-bold">COST_$/HR</p>
                  <div className="space-y-1 font-mono text-xs">
                    <div className="flex justify-between">
                      <span className="text-neon-cyan/70">Compute:</span>
                      <span className="text-neon-lime font-bold">${rec.computePerHour.toFixed(3)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neon-cyan/70">Egress:</span>
                      <span className="text-neon-lime font-bold">${rec.egressPerHour.toFixed(3)}</span>
                    </div>
                    <div className="flex justify-between border-t border-neon-cyan/20 pt-1">
                      <span className={`font-bold ${idx === 0 ? 'text-neon-magenta' : 'text-neon-cyan'}`}>Total:</span>
                      <span className={`font-bold text-lg ${idx === 0 ? 'text-neon-magenta' : 'text-neon-lime'}`}>${rec.totalPerHour.toFixed(3)}</span>
                    </div>
                  </div>
                </div>

                <button className={idx === 0 ? 'btn-neon-magenta' : 'btn-neon-cyan'}>
                  [ LAUNCH ]
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="neon-card rounded-lg border border-dashed border-neon-cyan/30 p-12 text-center">
          <p className="text-neon-cyan font-mono mb-4">[ SEARCH_FOR_GAME_RECOMMENDATIONS ]</p>
          <p className="text-sm text-neon-lime font-mono">optimal_instance_region_quality_budgetfinder</p>
        </div>
      )}
    </div>
  );
}
