import { query } from '../config/database';

interface PerformanceMetric {
  machineId: string;
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

interface PerformanceStats {
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

export class PerformanceService {
  static async recordMetrics(machineId: string, metrics: Omit<PerformanceMetric, 'machineId' | 'timestamp'>) {
    const timestamp = new Date().toISOString();

    await query(
      `INSERT INTO performance_metrics (
        machine_id,
        timestamp,
        cpu_usage,
        gpu_usage,
        gpu_memory_usage,
        gpu_memory_total,
        network_bandwidth_up,
        network_bandwidth_down,
        network_packet_loss,
        network_latency,
        streaming_fps,
        streaming_frame_drops,
        disk_read_iops,
        disk_write_iops,
        disk_read_mbps,
        disk_write_mbps,
        memory_usage,
        memory_total,
        gpu_temperature,
        cpu_temperature
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        machineId,
        timestamp,
        metrics.cpuUsage,
        metrics.gpuUsage,
        metrics.gpuMemoryUsage,
        metrics.gpuMemoryTotal,
        metrics.networkBandwidthUp,
        metrics.networkBandwidthDown,
        metrics.networkPacketLoss,
        metrics.networkLatency,
        metrics.streamingFps,
        metrics.streamingFrameDrops,
        metrics.diskReadIops,
        metrics.diskWriteIops,
        metrics.diskReadMbps,
        metrics.diskWriteMbps,
        metrics.memoryUsage,
        metrics.memoryTotal,
        metrics.gpuTemperature,
        metrics.cpuTemperature,
      ]
    );
  }

  static async getPerformanceStats(machineId: string, hoursBack: number = 1): Promise<PerformanceStats> {
    const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    // Get all metrics for the time period
    const historyResult = await query(
      `SELECT * FROM performance_metrics
       WHERE machine_id = $1 AND timestamp >= $2
       ORDER BY timestamp DESC
       LIMIT 360`,
      [machineId, cutoffTime]
    );

    const history = historyResult.rows;

    if (history.length === 0) {
      throw new Error(`No performance data for machine ${machineId}`);
    }

    const current = history[0];

    // Calculate averages
    const avgCpuUsage = history.reduce((sum: number, m: any) => sum + m.cpu_usage, 0) / history.length;
    const avgGpuUsage = history.reduce((sum: number, m: any) => sum + m.gpu_usage, 0) / history.length;
    const avgStreamingFps = history.reduce((sum: number, m: any) => sum + m.streaming_fps, 0) / history.length;
    const avgPacketLoss = history.reduce((sum: number, m: any) => sum + m.network_packet_loss, 0) / history.length;
    const avgNetworkLatency = history.reduce((sum: number, m: any) => sum + m.network_latency, 0) / history.length;

    // Calculate peaks
    const peakCpuUsage = Math.max(...history.map((m: any) => m.cpu_usage));
    const peakGpuUsage = Math.max(...history.map((m: any) => m.gpu_usage));
    const peakBandwidthUp = Math.max(...history.map((m: any) => m.network_bandwidth_up));
    const peakBandwidthDown = Math.max(...history.map((m: any) => m.network_bandwidth_down));
    const peakFrameDrops = Math.max(...history.map((m: any) => m.streaming_frame_drops));

    return {
      current: {
        machineId,
        timestamp: new Date(current.timestamp),
        cpuUsage: current.cpu_usage,
        gpuUsage: current.gpu_usage,
        gpuMemoryUsage: current.gpu_memory_usage,
        gpuMemoryTotal: current.gpu_memory_total,
        networkBandwidthUp: current.network_bandwidth_up,
        networkBandwidthDown: current.network_bandwidth_down,
        networkPacketLoss: current.network_packet_loss,
        networkLatency: current.network_latency,
        streamingFps: current.streaming_fps,
        streamingFrameDrops: current.streaming_frame_drops,
        diskReadIops: current.disk_read_iops,
        diskWriteIops: current.disk_write_iops,
        diskReadMbps: current.disk_read_mbps,
        diskWriteMbps: current.disk_write_mbps,
        memoryUsage: current.memory_usage,
        memoryTotal: current.memory_total,
        gpuTemperature: current.gpu_temperature,
        cpuTemperature: current.cpu_temperature,
      },
      average: {
        cpuUsage: parseFloat(avgCpuUsage.toFixed(1)),
        gpuUsage: parseFloat(avgGpuUsage.toFixed(1)),
        streamingFps: parseFloat(avgStreamingFps.toFixed(1)),
        networkPacketLoss: parseFloat(avgPacketLoss.toFixed(2)),
        networkLatency: parseFloat(avgNetworkLatency.toFixed(1)),
      },
      peak: {
        cpuUsage: parseFloat(peakCpuUsage.toFixed(1)),
        gpuUsage: parseFloat(peakGpuUsage.toFixed(1)),
        networkBandwidthUp: parseFloat(peakBandwidthUp.toFixed(2)),
        networkBandwidthDown: parseFloat(peakBandwidthDown.toFixed(2)),
        streamingFrameDrops: peakFrameDrops,
      },
      history: history.map((m: any) => ({
        machineId,
        timestamp: new Date(m.timestamp),
        cpuUsage: m.cpu_usage,
        gpuUsage: m.gpu_usage,
        gpuMemoryUsage: m.gpu_memory_usage,
        gpuMemoryTotal: m.gpu_memory_total,
        networkBandwidthUp: m.network_bandwidth_up,
        networkBandwidthDown: m.network_bandwidth_down,
        networkPacketLoss: m.network_packet_loss,
        networkLatency: m.network_latency,
        streamingFps: m.streaming_fps,
        streamingFrameDrops: m.streaming_frame_drops,
        diskReadIops: m.disk_read_iops,
        diskWriteIops: m.disk_write_iops,
        diskReadMbps: m.disk_read_mbps,
        diskWriteMbps: m.disk_write_mbps,
        memoryUsage: m.memory_usage,
        memoryTotal: m.memory_total,
        gpuTemperature: m.gpu_temperature,
        cpuTemperature: m.cpu_temperature,
      })),
    };
  }

  static async getRealtimeMetric(machineId: string) {
    const result = await query(
      `SELECT * FROM performance_metrics
       WHERE machine_id = $1
       ORDER BY timestamp DESC
       LIMIT 1`,
      [machineId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const m = result.rows[0];
    return {
      machineId,
      timestamp: new Date(m.timestamp),
      cpuUsage: m.cpu_usage,
      gpuUsage: m.gpu_usage,
      gpuMemoryUsage: m.gpu_memory_usage,
      gpuMemoryTotal: m.gpu_memory_total,
      networkBandwidthUp: m.network_bandwidth_up,
      networkBandwidthDown: m.network_bandwidth_down,
      networkPacketLoss: m.network_packet_loss,
      networkLatency: m.network_latency,
      streamingFps: m.streaming_fps,
      streamingFrameDrops: m.streaming_frame_drops,
      diskReadIops: m.disk_read_iops,
      diskWriteIops: m.disk_write_iops,
      diskReadMbps: m.disk_read_mbps,
      diskWriteMbps: m.disk_write_mbps,
      memoryUsage: m.memory_usage,
      memoryTotal: m.memory_total,
      gpuTemperature: m.gpu_temperature,
      cpuTemperature: m.cpu_temperature,
    };
  }

  static async getHealthStatus(machineId: string): Promise<{
    status: 'healthy' | 'warning' | 'critical';
    issues: string[];
  }> {
    const metric = await this.getRealtimeMetric(machineId);

    if (!metric) {
      return { status: 'critical', issues: ['No performance data'] };
    }

    const issues: string[] = [];

    if (metric.cpuUsage > 90) issues.push('CPU usage critically high');
    if (metric.gpuUsage > 95) issues.push('GPU usage at critical levels');
    if (metric.networkPacketLoss > 2) issues.push('High packet loss detected');
    if (metric.streamingFps < 30) issues.push('Frame rate below acceptable threshold');
    if (metric.gpuTemperature > 85) issues.push('GPU temperature warning');
    if (metric.cpuTemperature > 90) issues.push('CPU temperature warning');
    if (metric.networkLatency > 150) issues.push('High network latency');

    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (issues.length > 0) {
      status = issues.some(i => i.includes('critical')) ? 'critical' : 'warning';
    }

    return { status, issues };
  }
}
