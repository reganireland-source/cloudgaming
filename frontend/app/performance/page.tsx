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
    return (
      <div className="text-center py-12">
        <p className="font-mono text-neon-cyan">
          {'> SCANNING_PERFORMANCE_METRICS...'}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8 flex flex-col sm:flex-row justify-between items-start gap-4">
        <div>
          <h1 className="text-4xl font-bold neon-text mb-2 font-mono">[ PERFORMANCE_PORTAL ]</h1>
          <p className="font-mono text-neon-lime text-sm">
            {'> realtime_cpu_gpu_network_streaming_monitoring'.toUpperCase()}
          </p>
        </div>
        <div className="flex gap-2">
          <select
            value={refreshInterval}
            onChange={(e) => setRefreshInterval(parseInt(e.target.value))}
            className="input-neon px-4 py-2 rounded font-mono text-sm"
          >
            <option value="5">[ 5s ]</option>
            <option value="10">[ 10s ]</option>
            <option value="30">[ 30s ]</option>
            <option value="60">[ 1m ]</option>
          </select>
        </div>
      </div>

      {/* Machine Selection */}
      {machines.length > 1 && (
        <div className="neon-card rounded-lg p-4 mb-6 border-2 border-neon-cyan">
          <p className="text-xs text-neon-cyan mb-3 font-mono font-bold">[ SELECT_MACHINE ]</p>
          <div className="flex gap-2 flex-wrap">
            {machines.map((machine) => (
              <button
                key={machine.id}
                onClick={() => setSelectedMachineId(machine.id)}
                className={`px-4 py-2 rounded font-mono font-bold text-sm transition border-2 ${
                  selectedMachineId === machine.id
                    ? 'border-neon-magenta bg-magenta-950/30 text-neon-magenta'
                    : 'border-neon-cyan/50 text-neon-cyan/70 hover:border-neon-cyan hover:text-neon-cyan'
                }`}
              >
                {machine.instance_type} / {machine.provider.toUpperCase()}
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
      <div className="mt-12 neon-card rounded-lg border-2 border-neon-cyan p-6">
        <h3 className="text-lg font-bold neon-text mb-4 font-mono">[ PERFORMANCE_TIPS ]</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="neon-card-cyan rounded p-4 border border-neon-cyan">
            <h4 className="font-bold text-neon-cyan mb-2 font-mono text-sm">💻 CPU_USAGE</h4>
            <p className="text-xs text-neon-lime font-mono">Keep below 80% for stable perf. High usage → stuttering + frame drops.</p>
          </div>
          <div className="neon-card-magenta rounded p-4 border border-neon-magenta">
            <h4 className="font-bold text-neon-magenta mb-2 font-mono text-sm">🎮 GPU_USAGE</h4>
            <p className="text-xs text-neon-cyan font-mono">Gaming: 80-95% normal. Above 95% = thermal throttling risk.</p>
          </div>
          <div className="neon-card-lime rounded p-4 border border-neon-lime">
            <h4 className="font-bold text-neon-lime mb-2 font-mono text-sm">📊 FRAME_RATE</h4>
            <p className="text-xs text-neon-magenta font-mono">Target 60 FPS. Below 50 FPS = investigate performance.</p>
          </div>
          <div className="neon-card-pink rounded p-4 border border-neon-pink">
            <h4 className="font-bold text-neon-pink mb-2 font-mono text-sm">🌐 NETWORK</h4>
            <p className="text-xs text-neon-cyan font-mono">Packet loss above 1% or latency above 100ms = quality issues. Use wired.</p>
          </div>
          <div className="neon-card rounded p-4 border border-neon-cyan">
            <h4 className="font-bold text-neon-cyan mb-2 font-mono text-sm">🌡️ TEMPERATURE</h4>
            <p className="text-xs text-neon-lime font-mono">CPU below 80°C, GPU below 75°C. High temps = throttle. Check cooling.</p>
          </div>
          <div className="neon-card-magenta rounded p-4 border border-neon-magenta">
            <h4 className="font-bold text-neon-magenta mb-2 font-mono text-sm">💾 STORAGE</h4>
            <p className="text-xs text-neon-cyan font-mono">Disk I/O bottlenecks impact load times. SSD beats HDD for gaming.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
