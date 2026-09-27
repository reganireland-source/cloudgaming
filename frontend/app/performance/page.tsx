'use client';

import { useState, useEffect } from 'react';
import PerformanceStats from '@/components/PerformanceStats';

interface Machine {
  id: string;
  instance_type: string;
  provider: string;
  region: string;
  status: string;
}

interface PerformanceMetric {
  timestamp: Date;
  cpuUsage: number;
  gpuUsage: number;
  gpuMemoryUsage: number;
  gpuMemoryTotal: number;
  networkBandwidthUp: number;
  networkBandwidthDown: number;
  networkPacketLoss: number;
  networkLatency: number;
  streamingFps: number;
  streamingFrameDrops: number;
  diskReadIops: number;
  diskWriteIops: number;
  diskReadMbps: number;
  diskWriteMbps: number;
  memoryUsage: number;
  memoryTotal: number;
  gpuTemperature: number;
  cpuTemperature: number;
}

interface PerformanceData {
  current: PerformanceMetric;
  average: {
    cpuUsage: number;
    gpuUsage: number;
    streamingFps: number;
    networkPacketLoss: number;
    networkLatency: number;
  };
  peak: {
    cpuUsage: number;
    gpuUsage: number;
    networkBandwidthUp: number;
    networkBandwidthDown: number;
    streamingFrameDrops: number;
  };
  history: PerformanceMetric[];
}

export default function PerformancePage() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const [performanceData, setPerformanceData] = useState<PerformanceData | null>(null);
  const [healthStatus, setHealthStatus] = useState<'healthy' | 'warning' | 'critical'>('healthy');
  const [loading, setLoading] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(10); // seconds

  useEffect(() => {
    // Mock machines for demo
    const mockMachines: Machine[] = [
      {
        id: '1',
        instance_type: 'g4dn.xlarge',
        provider: 'aws',
        region: 'us-east-1',
        status: 'running',
      },
      {
        id: '2',
        instance_type: 'Standard_NV6',
        provider: 'azure',
        region: 'eastus',
        status: 'running',
      },
    ];

    setMachines(mockMachines);
    setSelectedMachineId(mockMachines[0].id);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!selectedMachineId) return;

    const fetchPerformanceData = async () => {
      // Mock performance data
      const mockHistory = Array.from({ length: 60 }, (_, i) => ({
        timestamp: new Date(Date.now() - (59 - i) * 60000),
        cpuUsage: 45 + Math.random() * 30,
        gpuUsage: 70 + Math.random() * 25,
        gpuMemoryUsage: 8192,
        gpuMemoryTotal: 12288,
        networkBandwidthUp: 5 + Math.random() * 10,
        networkBandwidthDown: 35 + Math.random() * 5,
        networkPacketLoss: Math.random() * 0.5,
        networkLatency: 15 + Math.random() * 20,
        streamingFps: 58 + Math.random() * 2,
        streamingFrameDrops: Math.floor(Math.random() * 2),
        diskReadIops: 100 + Math.random() * 200,
        diskWriteIops: 50 + Math.random() * 150,
        diskReadMbps: 50 + Math.random() * 100,
        diskWriteMbps: 25 + Math.random() * 75,
        memoryUsage: 12288,
        memoryTotal: 16384,
        gpuTemperature: 65 + Math.random() * 15,
        cpuTemperature: 55 + Math.random() * 20,
      }));

      const current = mockHistory[mockHistory.length - 1];

      const averageCpu = mockHistory.reduce((sum, m) => sum + m.cpuUsage, 0) / mockHistory.length;
      const averageGpu = mockHistory.reduce((sum, m) => sum + m.gpuUsage, 0) / mockHistory.length;
      const averageFps = mockHistory.reduce((sum, m) => sum + m.streamingFps, 0) / mockHistory.length;
      const averageLoss = mockHistory.reduce((sum, m) => sum + m.networkPacketLoss, 0) / mockHistory.length;
      const averageLatency = mockHistory.reduce((sum, m) => sum + m.networkLatency, 0) / mockHistory.length;

      const peakCpu = Math.max(...mockHistory.map(m => m.cpuUsage));
      const peakGpu = Math.max(...mockHistory.map(m => m.gpuUsage));
      const peakBandwidthUp = Math.max(...mockHistory.map(m => m.networkBandwidthUp));
      const peakBandwidthDown = Math.max(...mockHistory.map(m => m.networkBandwidthDown));
      const peakFrameDrops = Math.max(...mockHistory.map(m => m.streamingFrameDrops));

      setPerformanceData({
        current,
        average: {
          cpuUsage: averageCpu,
          gpuUsage: averageGpu,
          streamingFps: averageFps,
          networkPacketLoss: averageLoss,
          networkLatency: averageLatency,
        },
        peak: {
          cpuUsage: peakCpu,
          gpuUsage: peakGpu,
          networkBandwidthUp: peakBandwidthUp,
          networkBandwidthDown: peakBandwidthDown,
          streamingFrameDrops: peakFrameDrops,
        },
        history: mockHistory,
      });

      // Determine health status
      if (peakCpu > 95 || peakGpu > 98 || averageLoss > 2) {
        setHealthStatus('critical');
      } else if (peakCpu > 80 || peakGpu > 90 || averageLoss > 1) {
        setHealthStatus('warning');
      } else {
        setHealthStatus('healthy');
      }
    };

    fetchPerformanceData();

    const interval = setInterval(fetchPerformanceData, refreshInterval * 1000);
    return () => clearInterval(interval);
  }, [selectedMachineId, refreshInterval]);

  if (loading) {
    return <div className="text-center py-12">Loading...</div>;
  }

  return (
    <div>
      <div className="mb-8 flex justify-between items-start">
        <div>
          <h1 className="text-4xl font-bold text-gray-900 mb-2">Performance Portal</h1>
          <p className="text-gray-600">Real-time monitoring of CPU, GPU, network, and streaming performance</p>
        </div>
        <div className="flex gap-2">
          <select
            value={refreshInterval}
            onChange={(e) => setRefreshInterval(parseInt(e.target.value))}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          >
            <option value="5">Refresh: 5s</option>
            <option value="10">Refresh: 10s</option>
            <option value="30">Refresh: 30s</option>
            <option value="60">Refresh: 1m</option>
          </select>
        </div>
      </div>

      {/* Machine Selection */}
      {machines.length > 1 && (
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <p className="text-sm text-gray-600 mb-3">Select Machine:</p>
          <div className="flex gap-2 flex-wrap">
            {machines.map((machine) => (
              <button
                key={machine.id}
                onClick={() => setSelectedMachineId(machine.id)}
                className={`px-4 py-2 rounded-lg font-medium transition ${
                  selectedMachineId === machine.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {machine.instance_type} ({machine.provider.toUpperCase()})
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Performance Stats */}
      {performanceData && selectedMachineId && (
        <PerformanceStats
          machineId={selectedMachineId}
          current={performanceData.current}
          average={performanceData.average}
          peak={performanceData.peak}
          history={performanceData.history}
          healthStatus={healthStatus}
        />
      )}

      {/* Performance Tips */}
      <div className="mt-12 bg-blue-50 rounded-lg border border-blue-200 p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-4">Performance Tips</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <h4 className="font-semibold text-gray-900 mb-2">💻 CPU Usage</h4>
            <p className="text-sm text-gray-700">Keep below 80% for stable performance. High CPU usage can cause stuttering and frame drops.</p>
          </div>
          <div>
            <h4 className="font-semibold text-gray-900 mb-2">🎮 GPU Usage</h4>
            <p className="text-sm text-gray-700">Gaming workloads are GPU-intensive. 80-95% usage is normal. Above 95% may cause thermal throttling.</p>
          </div>
          <div>
            <h4 className="font-semibold text-gray-900 mb-2">📊 Frame Rate</h4>
            <p className="text-sm text-gray-700">Target 60 FPS for smooth gameplay. Drops below 50 FPS indicate performance issues that need investigation.</p>
          </div>
          <div>
            <h4 className="font-semibold text-gray-900 mb-2">🌐 Network</h4>
            <p className="text-sm text-gray-700">Packet loss over 1% or latency over 100ms affects streaming quality. Use wired connections when possible.</p>
          </div>
          <div>
            <h4 className="font-semibold text-gray-900 mb-2">🌡️ Temperature</h4>
            <p className="text-sm text-gray-700">CPU should stay below 80°C, GPU below 75°C. High temps throttle performance. Check cooling system if consistently hot.</p>
          </div>
          <div>
            <h4 className="font-semibold text-gray-900 mb-2">💾 Storage</h4>
            <p className="text-sm text-gray-700">Disk I/O bottlenecks can impact load times. Monitor read/write speeds. SSD gives better gaming performance.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
