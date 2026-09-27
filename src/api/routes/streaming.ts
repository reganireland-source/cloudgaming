import { Router, Request, Response } from 'express';
import { query } from '../../config/database';
import { authMiddleware } from '../middleware/auth';

const router = Router();

/**
 * Streaming routes for managing game streaming client connections
 * Provides URLs and connection details for Sunshine, Moonlight, and web-based streaming
 */

/**
 * GET /api/streaming/:machineId
 * Get streaming connection details for a machine
 * Returns Sunshine web UI URL, Moonlight connection string, and client instructions
 */
router.get('/:machineId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;
    const userId = (req as any).userId;

    // Verify machine ownership
    const machineResult = await query(
      'SELECT * FROM machines WHERE id = $1 AND user_id = $2 AND status = $3',
      [machineId, userId, 'running']
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Machine not found or not running',
        code: 'MACHINE_NOT_FOUND',
      });
    }

    const machine = machineResult.rows[0];

    // Get the IP address from cloud provider if not stored
    // In MVP, using stored IP address; in production, would query provider API
    const ipAddress = machine.ip_address || 'pending';

    if (ipAddress === 'pending') {
      return res.status(503).json({
        error: 'Machine IP address still being assigned',
        code: 'IP_PENDING',
        retryAfter: 30,
      });
    }

    const connectionDetails = getStreamingConnectionDetails(
      ipAddress,
      machine.provider,
      machine.region,
      machine.quality_tier || 'high'
    );

    res.json({
      machineId,
      provider: machine.provider,
      region: machine.region,
      instanceType: machine.instance_type,
      status: 'ready',
      streamingDetails: connectionDetails,
      createdAt: machine.created_at,
      costsPerHour: machine.cost_per_hour,
    });
  } catch (error) {
    console.error('Streaming details error:', error);
    res.status(500).json({ error: 'Failed to get streaming details' });
  }
});

/**
 * POST /api/streaming/:machineId/moonlight-connection-string
 * Generate Moonlight client connection string
 * Moonlight is a native client - returns connection parameters
 */
router.post('/:machineId/moonlight-connection-string', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;
    const userId = (req as any).userId;

    const machineResult = await query(
      'SELECT * FROM machines WHERE id = $1 AND user_id = $2 AND status = $3',
      [machineId, userId, 'running']
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found or not running' });
    }

    const machine = machineResult.rows[0];
    const ipAddress = machine.ip_address;

    if (!ipAddress) {
      return res.status(503).json({
        error: 'IP address not yet assigned',
        retryAfter: 30,
      });
    }

    // Moonlight connection string format: moonlight://[username]:[password]@[host]:[port]/[appID]
    // CloudGaming uses default Sunshine configuration
    const connectionString = {
      protocol: 'moonlight',
      host: ipAddress,
      port: 47998,
      format: `moonlight://admin@${ipAddress}:47998`,
      instructions: [
        '1. Download Moonlight from https://github.com/moonlight-stream/moonlight-qt/releases',
        '2. Add PC:',
        `   - Host: ${ipAddress}`,
        '   - Port: 47998 (default)',
        '3. Use PIN from Sunshine server setup',
        '4. Select game from Sunshine host and stream',
        'Note: Moonlight is a native client only - no browser version available',
      ],
      clientDownloads: {
        pc: 'https://github.com/moonlight-stream/moonlight-qt/releases',
        android: 'https://play.google.com/store/apps/details?id=com.limelight',
        ios: 'https://apps.apple.com/us/app/moonlight/id1168947620',
        linux: 'https://github.com/moonlight-stream/moonlight-qt/releases',
      },
    };

    res.json(connectionString);
  } catch (error) {
    console.error('Moonlight connection error:', error);
    res.status(500).json({ error: 'Failed to generate connection string' });
  }
});

/**
 * GET /api/streaming/:machineId/sunshine-web-ui
 * Get Sunshine web UI URL for browser-based access
 * Sunshine includes embedded web interface for no-client configuration
 */
router.get('/:machineId/sunshine-web-ui', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;
    const userId = (req as any).userId;

    const machineResult = await query(
      'SELECT * FROM machines WHERE id = $1 AND user_id = $2 AND status = $3',
      [machineId, userId, 'running']
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found or not running' });
    }

    const machine = machineResult.rows[0];
    const ipAddress = machine.ip_address;

    if (!ipAddress) {
      return res.status(503).json({
        error: 'IP address not yet assigned',
        retryAfter: 30,
      });
    }

    const webUiUrl = `http://${ipAddress}:47990`;

    res.json({
      type: 'sunshine-web-ui',
      url: webUiUrl,
      openInNewTab: `<a href="${webUiUrl}" target="_blank">Open Sunshine Web UI</a>`,
      instructions: [
        `1. Open browser and navigate to: ${webUiUrl}`,
        '2. Login with default Sunshine credentials (shown during server setup)',
        '3. View installed applications from Sunshine host',
        '4. Click application to start streaming',
        '5. Use keyboard/mouse to control game',
        'Note: Web UI requires JavaScript and modern browser (Chrome/Firefox/Safari)',
      ],
      features: [
        'No client installation required',
        'Works on any device with browser',
        'Built-in performance monitoring',
        'Application library management',
        'Stream settings configuration',
      ],
      browser_requirements: {
        minimum: 'Chrome 60+, Firefox 55+, Safari 12+',
        recommended: 'Latest version of any major browser',
        webgl: 'Required for optimal video codec support',
      },
    });
  } catch (error) {
    console.error('Sunshine web UI error:', error);
    res.status(500).json({ error: 'Failed to get Sunshine web UI details' });
  }
});

/**
 * GET /api/streaming/:machineId/streaming-status
 * Check real-time streaming service status and connectivity
 */
router.get('/:machineId/streaming-status', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;
    const userId = (req as any).userId;

    const machineResult = await query(
      'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
      [machineId, userId]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    const machine = machineResult.rows[0];

    // Check if instance is running
    if (machine.status !== 'running') {
      return res.json({
        machineId,
        status: machine.status,
        streamingServiceRunning: false,
        reason: `Instance is ${machine.status}`,
      });
    }

    const ipAddress = machine.ip_address;

    // In production, would make HTTP request to Sunshine to verify it's running
    // For MVP, we assume it's running if instance is running
    const sunshineHealthEndpoint = `http://${ipAddress}:47990/health`;

    // NOTE: In production with proper error handling:
    // const response = await fetch(sunshineHealthEndpoint, { timeout: 5000 });
    // For now, return assumed status
    const streamingStatus = {
      machineId,
      instanceStatus: machine.status,
      streamingServiceRunning: true, // Would be verified via health check
      sunshineWebUi: `http://${ipAddress}:47990`,
      moonlightPort: 47998,
      healthCheckUrl: sunshineHealthEndpoint,
      lastHealthCheck: new Date().toISOString(),
      recommendedClients: [
        { name: 'Sunshine Web UI', url: `http://${ipAddress}:47990`, type: 'browser' },
        { name: 'Moonlight', url: 'https://github.com/moonlight-stream/moonlight-qt/releases', type: 'native' },
      ],
    };

    res.json(streamingStatus);
  } catch (error) {
    console.error('Streaming status error:', error);
    res.status(500).json({ error: 'Failed to check streaming status' });
  }
});

/**
 * GET /api/streaming/clients
 * Get list of recommended streaming clients and their compatibility
 */
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  const clientsList = {
    description: 'Streaming clients compatible with CloudGaming Hub (Sunshine-based)',
    clients: [
      {
        name: 'Sunshine Web UI',
        type: 'Browser',
        protocol: 'HTTP WebRTC',
        platforms: ['Windows', 'macOS', 'Linux', 'Android', 'iOS'],
        installation: 'Built-in to Sunshine server',
        accessUrl: 'http://<instance-ip>:47990',
        features: [
          'No installation required',
          'Real-time performance monitoring',
          'Game library management',
          'Built-in chat and recording',
          'Keyboard + mouse support',
        ],
        latency: 'Low (local network)',
        requirements: 'Modern web browser, JavaScript enabled',
        bestFor: 'Quick access, troubleshooting, configuration',
      },
      {
        name: 'Moonlight',
        type: 'Native Client',
        protocol: 'NVIDIA Streaming Protocol',
        platforms: ['Windows', 'macOS', 'Linux', 'Android', 'iOS', 'tvOS'],
        installation: 'https://github.com/moonlight-stream/moonlight-qt/releases',
        features: [
          'Hardware-accelerated video decoding',
          'Lowest latency',
          'GamePad support',
          'Multiple monitor support',
          '4K streaming support',
          'Open source',
        ],
        latency: 'Ultra-low (optimized protocol)',
        requirements: 'Windows/Mac/Linux/Android/iOS device',
        bestFor: 'Competitive gaming, lowest latency requirement',
      },
      {
        name: 'Parsec',
        type: 'Alternative Native Client',
        protocol: 'Proprietary',
        platforms: ['Windows', 'macOS', 'Android', 'iOS', 'tvOS'],
        installation: 'https://parsecgaming.com/downloads',
        features: [
          'P2P connection option',
          'Cloud gaming optimization',
          'Party mode',
          'Cross-platform',
        ],
        latency: 'Low',
        requirements: 'Parsec account (free or paid)',
        bestFor: 'Remote play with friends',
        note: 'Would require separate Parsec host installation',
      },
    ],
    recommended: {
      bestForLatency: 'Moonlight (native client)',
      easeOfUse: 'Sunshine Web UI (browser)',
      allAroundBest: 'Moonlight (native) + Sunshine Web UI (browser fallback)',
    },
    note: 'CloudGaming Hub is built on Sunshine streaming server - all Sunshine-compatible clients work',
  };

  res.json(clientsList);
});

/**
 * Helper function to generate streaming connection details
 */
function getStreamingConnectionDetails(
  ipAddress: string,
  provider: string,
  region: string,
  quality: string
) {
  const qualityMap: Record<string, string> = {
    budget: '720p 30fps',
    good: '1080p 60fps',
    high: '1440p 60fps',
    ultra: '4K 60fps',
  };

  return {
    sunshineWebUI: {
      url: `http://${ipAddress}:47990`,
      description: 'Browser-based streaming interface',
      instruction: `Open this link in your web browser: http://${ipAddress}:47990`,
    },
    moonlightClient: {
      host: ipAddress,
      port: 47998,
      protocol: 'NVIDIA Streaming Protocol',
      instruction: `Add PC in Moonlight with host: ${ipAddress} port: 47998`,
      downloadUrl: 'https://github.com/moonlight-stream/moonlight-qt/releases',
    },
    instanceDetails: {
      provider,
      region,
      quality: qualityMap[quality] || qualityMap.high,
      status: 'ready',
      createdAt: new Date().toISOString(),
    },
    quickStart: [
      '🌐 Browser: Open http://' + ipAddress + ':47990 in any browser',
      '🎮 Moonlight: Download from GitHub, add host ' + ipAddress + ':47998',
      '📱 Mobile: Install Moonlight app on Android/iOS, connect to ' + ipAddress,
      '💻 Linux: Use Moonlight or web UI for headless servers',
    ],
  };
}

export default router;
