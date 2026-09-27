'use client';

import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart, Bar } from 'recharts';

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

interface PerformanceStatsProps {
  machineId: string;
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
  healthStatus: 'healthy' | 'warning' | 'critical';
}

const StatCard = ({ label, value, unit, color, threshold }: any) => {
  const isWarning = threshold && value > threshold.warning;
  const isCritical = threshold && value > threshold.critical;

  const bgColor = isCritical ? 'bg-red-50' : isWarning ? 'bg-yellow-50' : 'bg-blue-50';
  const textColor = isCritical ? 'text-red-600' : isWarning ? 'text-yellow-600' : 'text-blue-600';
  const borderColor = isCritical ? 'border-red-200' : isWarning ? 'border-yellow-200' : 'border-blue-200';

  return (
    <div className={`${bgColor} rounded-lg border ${borderColor} p-4`}>
      <p className="text-sm text-gray-600 mb-1">{label}</p>
      <p className={`text-3xl font-bold ${textColor}`}>
        {typeof value === 'number' ? value.toFixed(1) : value}
        <span className="text-lg ml-1">{unit}</span>
      </p>
      {isCritical && <p className="text-xs text-red-600 mt-1">⚠️ Critical</p>}
      {isWarning && !isCritical && <p className="text-xs text-yellow-600 mt-1">⚠️ Warning</p>}
    </div>
  );
};

export default function PerformanceStats({
  machineId,
  current,
  average,
  peak,
  history,
  healthStatus,
}: PerformanceStatsProps) {
  const chartData = history.map((m) => ({
    time: new Date(m.timestamp).toLocaleTimeString(),
    cpu: m.cpuUsage,
    gpu: m.gpuUsage,
    fps: m.streamingFps,
    latency: m.networkLatency,
    packetLoss: m.networkPacketLoss,
    bandwidthUp: m.networkBandwidthUp,
    bandwidthDown: m.networkBandwidthDown,
    diskRead: m.diskReadMbps,
    diskWrite: m.diskWriteMbps,
  }));

  const memoryPercent = (current.gpuMemoryUsage / current.gpuMemoryTotal) * 100;
  const systemMemoryPercent = (current.memoryUsage / current.memoryTotal) * 100;

  return (
    <div className="space-y-8">
      {/* Health Status Banner */}
      <div className={`rounded-lg p-6 ${
        healthStatus === 'healthy'
          ? 'bg-green-50 border border-green-200'
          : healthStatus === 'warning'
          ? 'bg-yellow-50 border border-yellow-200'
          : 'bg-red-50 border border-red-200'
      }`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900 mb-1">System Health</h2>
            <p className={`text-lg font-semibold ${
              healthStatus === 'healthy'
                ? 'text-green-700'
                : healthStatus === 'warning'
                ? 'text-yellow-700'
                : 'text-red-700'
            }`}>
              {healthStatus === 'healthy' ? '✓ Healthy' : healthStatus === 'warning' ? '⚠ Warning' : '✕ Critical'}
            </p>
          </div>
          <div className={`w-16 h-16 rounded-full flex items-center justify-center ${
            healthStatus === 'healthy'
              ? 'bg-green-200'
              : healthStatus === 'warning'
              ? 'bg-yellow-200'
              : 'bg-red-200'
          }`}>
            <span className="text-3xl">{healthStatus === 'healthy' ? '✓' : '!'}</span>
          </div>
        </div>
      </div>

      {/* Current Metrics Grid */}
      <div>
        <h3 className="text-2xl font-bold text-gray-900 mb-4">Real-Time Metrics</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard
            label="CPU Usage"
            value={current.cpuUsage}
            unit="%"
            color="blue"
            threshold={{ warning: 80, critical: 95 }}
          />
          <StatCard
            label="GPU Usage"
            value={current.gpuUsage}
            unit="%"
            color="purple"
            threshold={{ warning: 90, critical: 98 }}
          />
          <StatCard
            label="GPU Memory"
            value={memoryPercent}
            unit="%"
            color="indigo"
          />
          <StatCard
            label="Stream FPS"
            value={current.streamingFps}
            unit="fps"
            color="green"
            threshold={{ warning: 50, critical: 30 }}
          />
          <StatCard
            label="Packet Loss"
            value={current.networkPacketLoss}
            unit="%"
            color="orange"
            threshold={{ warning: 1, critical: 2 }}
          />
          <StatCard
            label="Latency"
            value={current.networkLatency}
            unit="ms"
            color="red"
            threshold={{ warning: 100, critical: 150 }}
          />
        </div>
      </div>

      {/* Temperature and Memory */}
      <div>
        <h3 className="text-xl font-bold text-gray-900 mb-4">System Resources</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="CPU Temp"
            value={current.cpuTemperature}
            unit="°C"
            threshold={{ warning: 80, critical: 90 }}
          />
          <StatCard
            label="GPU Temp"
            value={current.gpuTemperature}
            unit="°C"
            threshold={{ warning: 75, critical: 85 }}
          />
          <StatCard
            label="System Memory"
            value={systemMemoryPercent}
            unit="%"
            threshold={{ warning: 80, critical: 95 }}
          />
          <StatCard
            label="Frame Drops"
            value={current.streamingFrameDrops}
            unit="drops"
            threshold={{ warning: 5, critical: 10 }}
          />
        </div>
      </div>

      {/* Network Performance */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-xl font-bold text-gray-900 mb-4">Network Performance</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div className="space-y-3">
            <h4 className="font-semibold text-gray-800">Bandwidth</h4>
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-gray-600">Upload (Current)</span>
              <span className="font-bold">{current.networkBandwidthUp.toFixed(2)} Mbps</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-gray-600">Upload (Peak)</span>
              <span className="font-bold">{peak.networkBandwidthUp.toFixed(2)} Mbps</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-gray-600">Download (Current)</span>
              <span className="font-bold">{current.networkBandwidthDown.toFixed(2)} Mbps</span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-gray-600">Download (Peak)</span>
              <span className="font-bold">{peak.networkBandwidthDown.toFixed(2)} Mbps</span>
            </div>
          </div>
          <div className="space-y-3">
            <h4 className="font-semibold text-gray-800">Connection Quality</h4>
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-gray-600">Latency (Current)</span>
              <span className="font-bold">{current.networkLatency.toFixed(1)} ms</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-gray-600">Latency (Average)</span>
              <span className="font-bold">{average.networkLatency.toFixed(1)} ms</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-gray-600">Packet Loss</span>
              <span className="font-bold">{current.networkPacketLoss.toFixed(2)}%</span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-gray-600">Packet Loss (Avg)</span>
              <span className="font-bold">{average.networkPacketLoss.toFixed(2)}%</span>
            </div>
          </div>
        </div>
      </div>

      {/* CPU & GPU Usage Chart */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-xl font-bold text-gray-900 mb-4">CPU & GPU Usage</h3>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="colorGpu" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#a855f7" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="time" />
            <YAxis domain={[0, 100]} label={{ value: '%', angle: -90, position: 'insideLeft' }} />
            <Tooltip formatter={(value) => `${value.toFixed(1)}%`} />
            <Legend />
            <Area type="monotone" dataKey="cpu" stroke="#3b82f6" fillOpacity={1} fill="url(#colorCpu)" name="CPU %" />
            <Area type="monotone" dataKey="gpu" stroke="#a855f7" fillOpacity={1} fill="url(#colorGpu)" name="GPU %" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Frame Rate & Packet Loss */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-xl font-bold text-gray-900 mb-4">Streaming Quality Indicators</h3>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="time" />
            <YAxis yAxisId="left" domain={[0, 65]} label={{ value: 'FPS', angle: -90, position: 'insideLeft' }} />
            <YAxis yAxisId="right" orientation="right" domain={[0, 5]} label={{ value: 'Packet Loss %', angle: 90, position: 'insideRight' }} />
            <Tooltip />
            <Legend />
            <Line yAxisId="left" type="monotone" dataKey="fps" stroke="#10b981" name="FPS" strokeWidth={2} />
            <Bar yAxisId="right" dataKey="packetLoss" fill="#ef4444" name="Packet Loss %" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Disk I/O */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-xl font-bold text-gray-900 mb-4">Disk I/O Performance</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Disk Read (IOPS)"
            value={current.diskReadIops}
            unit="ops/s"
          />
          <StatCard
            label="Disk Write (IOPS)"
            value={current.diskWriteIops}
            unit="ops/s"
          />
          <StatCard
            label="Read Speed"
            value={current.diskReadMbps}
            unit="MB/s"
          />
          <StatCard
            label="Write Speed"
            value={current.diskWriteMbps}
            unit="MB/s"
          />
        </div>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="time" />
            <YAxis label={{ value: 'MB/s', angle: -90, position: 'insideLeft' }} />
            <Tooltip formatter={(value) => `${value.toFixed(2)} MB/s`} />
            <Legend />
            <Line type="monotone" dataKey="diskRead" stroke="#0ea5e9" name="Read Speed" strokeWidth={2} />
            <Line type="monotone" dataKey="diskWrite" stroke="#f59e0b" name="Write Speed" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Statistics Summary */}
      <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg border border-blue-200 p-6">
        <h3 className="text-xl font-bold text-gray-900 mb-4">Performance Summary (Last Hour)</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
          <div>
            <p className="text-sm text-gray-600 mb-1">Avg CPU Usage</p>
            <p className="text-2xl font-bold text-blue-600">{average.cpuUsage.toFixed(1)}%</p>
            <p className="text-xs text-gray-500 mt-1">Peak: {peak.cpuUsage.toFixed(1)}%</p>
          </div>
          <div>
            <p className="text-sm text-gray-600 mb-1">Avg GPU Usage</p>
            <p className="text-2xl font-bold text-purple-600">{average.gpuUsage.toFixed(1)}%</p>
            <p className="text-xs text-gray-500 mt-1">Peak: {peak.gpuUsage.toFixed(1)}%</p>
          </div>
          <div>
            <p className="text-sm text-gray-600 mb-1">Avg FPS</p>
            <p className="text-2xl font-bold text-green-600">{average.streamingFps.toFixed(1)}</p>
            <p className="text-xs text-gray-500 mt-1">Drops: {peak.streamingFrameDrops}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600 mb-1">Avg Latency</p>
            <p className="text-2xl font-bold text-orange-600">{average.networkLatency.toFixed(1)}ms</p>
            <p className="text-xs text-gray-500 mt-1">Stability: Good</p>
          </div>
          <div>
            <p className="text-sm text-gray-600 mb-1">Avg Packet Loss</p>
            <p className="text-2xl font-bold text-red-600">{average.networkPacketLoss.toFixed(2)}%</p>
            <p className="text-xs text-gray-500 mt-1">Quality: Excellent</p>
          </div>
          <div>
            <p className="text-sm text-gray-600 mb-1">Peak Bandwidth</p>
            <p className="text-2xl font-bold text-cyan-600">{peak.networkBandwidthDown.toFixed(2)}Mbps</p>
            <p className="text-xs text-gray-500 mt-1">Download</p>
          </div>
        </div>
      </div>
    </div>
  );
}
