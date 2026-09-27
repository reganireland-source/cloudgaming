import { query } from '../config/database';
import { PerformanceService } from '../services/PerformanceService';

/**
 * Background job: Collect performance metrics from running machines (every minute)
 * In production, would query CloudWatch/Azure Monitor/Stackdriver/OCI APIs
 * For MVP, generates realistic mock data
 */
export async function collectPerformanceMetricsJob() {
  console.log('[Job] Collecting performance metrics...');

  try {
    // Get all running machines
    const machinesResult = await query(
      `SELECT id FROM machines WHERE status = 'running'`
    );

    for (const machine of machinesResult.rows) {
      try {
        await collectMetricsForMachine(machine.id);
      } catch (error) {
        console.error(`Failed to collect metrics for machine ${machine.id}:`, error);
      }
    }

    console.log(`[Job] Collected metrics for ${machinesResult.rows.length} machines`);
  } catch (error) {
    console.error('[Job] Performance collection failed:', error);
  }
}

async function collectMetricsForMachine(machineId: string) {
  // In production, query cloud provider monitoring APIs:
  // AWS CloudWatch - CPUUtilization, GPUUtilization, NetworkIn/Out
  // Azure Monitor - PercentageCPU, GPU %, Network metrics
  // GCP Stackdriver - CPU usage, GPU metrics, network metrics
  // Oracle OCI Monitoring - similar metrics

  // For MVP: Generate realistic mock data with some variation
  const baselineData = {
    cpuUsage: 45 + Math.random() * 30, // 45-75% baseline with variance
    gpuUsage: 70 + Math.random() * 25, // 70-95% for gaming
    gpuMemoryUsage: 8192, // 8GB used (typical for 1440p streaming)
    gpuMemoryTotal: 12288, // 12GB total (NVIDIA RTX 3060 Ti equivalent)
    networkBandwidthUp: 5 + Math.random() * 10, // 5-15 Mbps upload
    networkBandwidthDown: 35 + Math.random() * 5, // 35-40 Mbps download (1440p streaming)
    networkPacketLoss: Math.random() * 0.5, // 0-0.5% packet loss
    networkLatency: 15 + Math.random() * 20, // 15-35ms baseline latency
    streamingFps: 58 + Math.random() * 2, // 58-60 FPS (target is 60)
    streamingFrameDrops: Math.floor(Math.random() * 2), // 0-1 drops per collection
    diskReadIops: 100 + Math.random() * 200, // 100-300 IOPS
    diskWriteIops: 50 + Math.random() * 150, // 50-200 IOPS
    diskReadMbps: 50 + Math.random() * 100, // 50-150 MB/s
    diskWriteMbps: 25 + Math.random() * 75, // 25-100 MB/s
    memoryUsage: 12288, // 12GB used
    memoryTotal: 16384, // 16GB total
    gpuTemperature: 65 + Math.random() * 15, // 65-80°C (normal for gaming)
    cpuTemperature: 55 + Math.random() * 20, // 55-75°C
  };

  // Add occasional spikes to make it realistic
  if (Math.random() < 0.1) { // 10% chance of a spike
    baselineData.cpuUsage = Math.min(99, baselineData.cpuUsage + 20);
    baselineData.gpuUsage = Math.min(99, baselineData.gpuUsage + 15);
  }

  // Add occasional frame drops
  if (Math.random() < 0.05) { // 5% chance
    baselineData.streamingFrameDrops += Math.floor(Math.random() * 3);
  }

  // Add occasional packet loss spikes
  if (Math.random() < 0.03) { // 3% chance
    baselineData.networkPacketLoss = Math.min(5, baselineData.networkPacketLoss + Math.random() * 2);
  }

  // Add latency variation
  if (Math.random() < 0.15) { // 15% chance of latency spike
    baselineData.networkLatency = Math.min(200, baselineData.networkLatency + Math.random() * 50);
  }

  await PerformanceService.recordMetrics(machineId, {
    cpuUsage: parseFloat(baselineData.cpuUsage.toFixed(1)),
    gpuUsage: parseFloat(baselineData.gpuUsage.toFixed(1)),
    gpuMemoryUsage: baselineData.gpuMemoryUsage,
    gpuMemoryTotal: baselineData.gpuMemoryTotal,
    networkBandwidthUp: parseFloat(baselineData.networkBandwidthUp.toFixed(2)),
    networkBandwidthDown: parseFloat(baselineData.networkBandwidthDown.toFixed(2)),
    networkPacketLoss: parseFloat(baselineData.networkPacketLoss.toFixed(2)),
    networkLatency: parseFloat(baselineData.networkLatency.toFixed(1)),
    streamingFps: parseFloat(baselineData.streamingFps.toFixed(1)),
    streamingFrameDrops: baselineData.streamingFrameDrops,
    diskReadIops: Math.floor(baselineData.diskReadIops),
    diskWriteIops: Math.floor(baselineData.diskWriteIops),
    diskReadMbps: parseFloat(baselineData.diskReadMbps.toFixed(2)),
    diskWriteMbps: parseFloat(baselineData.diskWriteMbps.toFixed(2)),
    memoryUsage: baselineData.memoryUsage,
    memoryTotal: baselineData.memoryTotal,
    gpuTemperature: parseFloat(baselineData.gpuTemperature.toFixed(1)),
    cpuTemperature: parseFloat(baselineData.cpuTemperature.toFixed(1)),
  });
}
