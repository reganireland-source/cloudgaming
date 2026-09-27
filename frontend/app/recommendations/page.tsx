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
        <h1 className="text-4xl font-bold text-gray-900 mb-2">Game Recommendations</h1>
        <p className="text-gray-600">Find the best cloud region and instance for your game and location</p>
      </div>

      {/* Search Form */}
      <form onSubmit={handleSearch} className="bg-white rounded-lg shadow p-6 mb-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Game Title</label>
            <input
              type="text"
              value={gameTitle}
              onChange={(e) => setGameTitle(e.target.value)}
              placeholder="e.g., Elden Ring"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Your Latitude</label>
            <input
              type="number"
              step="0.0001"
              value={userLat}
              onChange={(e) => setUserLat(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Your Longitude</label>
            <input
              type="number"
              step="0.0001"
              value={userLng}
              onChange={(e) => setUserLng(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Budget ($/hr)</label>
            <input
              type="number"
              step="0.01"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="Optional"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            type="submit"
            disabled={loading}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-6 py-2 rounded-lg font-medium"
          >
            {loading ? 'Searching...' : 'Get Recommendations'}
          </button>
          <button
            type="button"
            onClick={handleSetMyLocation}
            className="bg-gray-200 hover:bg-gray-300 text-gray-900 px-6 py-2 rounded-lg font-medium"
          >
            Use My Location
          </button>
        </div>
      </form>

      {/* Recommendations */}
      {recommendations.length > 0 ? (
        <div className="space-y-4">
          {recommendations.map((rec, idx) => (
            <div key={idx} className="bg-white rounded-lg shadow p-6 hover:shadow-lg transition">
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-center">
                <div>
                  <h3 className="font-semibold text-gray-900 text-lg">{rec.provider.toUpperCase()}</h3>
                  <p className="text-sm text-gray-600">{rec.region}</p>
                  <p className="text-xs text-gray-500 mt-1">{rec.instanceType}</p>
                </div>

                <div>
                  <p className="text-sm text-gray-600 mb-1">Streaming Quality</p>
                  <p className="font-semibold text-gray-900">{rec.quality.name}</p>
                  <p className="text-xs text-gray-600">{rec.quality.resolution} @ {rec.quality.fps}fps</p>
                </div>

                <div>
                  <p className="text-sm text-gray-600 mb-1">Latency</p>
                  <p className="text-2xl font-bold text-orange-600">{rec.latencyMs}ms</p>
                  <p className="text-xs text-gray-600 mt-1">{rec.latencyMs < 30 ? '✓ Excellent' : rec.latencyMs < 60 ? '⚠ Good' : 'Fair'}</p>
                </div>

                <div className="bg-gray-50 rounded p-4">
                  <p className="text-xs text-gray-600 mb-2">Hourly Cost</p>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-600">Compute:</span>
                      <span className="font-medium">${rec.computePerHour.toFixed(3)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-600">Egress:</span>
                      <span className="font-medium">${rec.egressPerHour.toFixed(3)}</span>
                    </div>
                    <div className="flex justify-between text-xs border-t pt-1">
                      <span className="font-semibold">Total:</span>
                      <span className="font-bold">${rec.totalPerHour.toFixed(3)}</span>
                    </div>
                  </div>
                </div>

                <button className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium whitespace-nowrap">
                  Launch Machine
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-gray-50 rounded-lg border-2 border-dashed border-gray-300 p-12 text-center">
          <p className="text-gray-600 mb-4">Search for a game to see recommendations</p>
          <p className="text-sm text-gray-500">We'll find the best instance type, region, and streaming quality for your budget and location</p>
        </div>
      )}
    </div>
  );
}
