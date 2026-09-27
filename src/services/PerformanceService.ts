/**
 * ============================================================================
 * src/services/PerformanceService.ts — STORING AND SUMMARISING MACHINE METRICS
 * ============================================================================
 *
 * Every so often a reading of how a gaming machine is doing (CPU/GPU load,
 * temperatures, network latency, frames per second...) is saved to the
 * `performance_metrics` table — one row per reading. This service:
 *   recordMetrics      save one reading
 *   getPerformanceStats   averages, peaks and history over the last N hours
 *   getRealtimeMetric  the single newest reading
 *   getHealthStatus    turn the newest reading into healthy/warning/critical
 * It backs the /api/performance routes and the Performance page.
 *
 * NAMING: the database uses snake_case (cpu_usage); the API returns
 * camelCase (cpuUsage). Much of this file is just renaming fields.
 *
 * ⚠️  KNOWN BUG — averages come out as NaN
 * ---------------------------------------
 * The `pg` driver returns DECIMAL/NUMERIC columns (cpu_usage, gpu_usage,
 * streaming_fps, network_packet_loss, network_latency...) as TEXT, e.g.
 * "45.20", to avoid losing precision. So `sum + m.cpu_usage` in
 * getPerformanceStats JOINS text ("0" + "45.20" + "50.10" -> "045.2050.10")
 * instead of adding numbers, and dividing that gives NaN ("not a number").
 * Math.max() happens to convert text to numbers, so the PEAKS are fine.
 * Fix: wrap each value in parseFloat(...) before adding (as costs.ts does).
 * The same text values also make the comparisons in getHealthStatus work
 * only by luck of JavaScript's automatic conversion.
 * ============================================================================
 */

import { query } from '../config/database';

/** One reading, in the camelCase shape the API returns. */
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

/** A summary over a time window: latest reading, averages, peaks, full history. */
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
  /**
   * Save one metrics reading for a machine.
   *
   * `Omit<PerformanceMetric, 'machineId' | 'timestamp'>` is a TypeScript
   * helper meaning "the PerformanceMetric shape, minus those two fields" —
   * the caller passes the measurements, and we add the id and time ourselves.
   * The INSERT lists 20 columns and 20 matching $1..$20 placeholders; the
   * values array must be in exactly the same order.
   */
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

  /**
   * Summarise the last `hoursBack` hours (default 1) of readings.
   * @throws if there are no readings in that window
   * ⚠️ Averages are NaN — see KNOWN BUG in the file header.
   */
  static async getPerformanceStats(machineId: string, hoursBack: number = 1): Promise<PerformanceStats> {
    // "N hours ago": now in milliseconds minus N × 60 min × 60 s × 1000 ms.
    const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    // Newest first, capped at 360 rows (e.g. 1 hour of 10-second readings)
    // so a long window can't return an enormous result.
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

    // Sorted newest-first, so the first row is the latest reading.
    const current = history[0];

    // Averages: add every reading (reduce, starting from 0) then divide by
    // the count. ⚠️ Broken for DECIMAL columns — see file header.
    const avgCpuUsage = history.reduce((sum: number, m: any) => sum + m.cpu_usage, 0) / history.length;
    const avgGpuUsage = history.reduce((sum: number, m: any) => sum + m.gpu_usage, 0) / history.length;
    const avgStreamingFps = history.reduce((sum: number, m: any) => sum + m.streaming_fps, 0) / history.length;
    const avgPacketLoss = history.reduce((sum: number, m: any) => sum + m.network_packet_loss, 0) / history.length;
    const avgNetworkLatency = history.reduce((sum: number, m: any) => sum + m.network_latency, 0) / history.length;

    // Peaks: the highest value seen. `...` (the "spread" operator) passes
    // every item of the array to Math.max as separate arguments:
    // Math.max(...[3, 9, 4]) is Math.max(3, 9, 4) = 9.
    const peakCpuUsage = Math.max(...history.map((m: any) => m.cpu_usage));
    const peakGpuUsage = Math.max(...history.map((m: any) => m.gpu_usage));
    const peakBandwidthUp = Math.max(...history.map((m: any) => m.network_bandwidth_up));
    const peakBandwidthDown = Math.max(...history.map((m: any) => m.network_bandwidth_down));
    const peakFrameDrops = Math.max(...history.map((m: any) => m.streaming_frame_drops));

    // Build the response: rename snake_case DB fields to camelCase, and
    // round averages/peaks. `x.toFixed(1)` gives TEXT with 1 decimal place;
    // parseFloat turns it back into a number.
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

  /**
   * The newest single reading for a machine, or null if there are none.
   */
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

  /**
   * Turn the latest reading into a simple verdict.
   *
   * Each threshold that's exceeded adds a human-readable issue. Then:
   *   no issues                          -> 'healthy'
   *   any issue containing "critical"    -> 'critical'
   *   otherwise                          -> 'warning'
   * (So only the CPU and GPU usage checks can produce 'critical' — the
   * decision is based on the wording of the message.)
   * No data at all counts as 'critical'.
   */
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
