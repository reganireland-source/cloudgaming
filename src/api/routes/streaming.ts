/**
 * ============================================================================
 * src/api/routes/streaming.ts — "HOW DO I CONNECT TO MY MACHINE TO PLAY?"
 * ============================================================================
 *
 * BACKGROUND: HOW CLOUD GAME STREAMING WORKS HERE
 * -----------------------------------------------
 * The game runs on the cloud machine. A program on that machine called
 * SUNSHINE captures the screen, compresses it into video, and streams it to
 * you; your keyboard/mouse/controller input is sent back. To watch that
 * stream you use a CLIENT on your own device:
 *   - Sunshine's own web page (browser)  -> http://<machine-ip>:47990
 *   - MOONLIGHT, a free native app with the lowest latency -> <machine-ip>, port 47998
 * A "port" is a numbered door on a machine; different services listen on
 * different ports. 47990 and 47998 are Sunshine's standard ones.
 *
 * Mounted at /api/streaming in src/index.ts. The login check (authMiddleware)
 * is applied to EACH route individually in this file rather than to the
 * whole router — same effect, all routes still require login.
 *
 *   GET  /api/streaming                                     which client apps are supported
 *   GET  /api/streaming/:machineId                          all connection details for a machine
 *   POST /api/streaming/:machineId/moonlight-connection-string
 *   GET  /api/streaming/:machineId/sunshine-web-ui
 *   GET  /api/streaming/:machineId/streaming-status
 *
 * ⚠️  KNOWN ISSUES
 * ---------------
 * 1. These handlers read `machine.ip_address`, but the `machines` table has
 *    no ip_address column (see database/schema.sql). So the IP is always
 *    missing and the per-machine endpoints always answer 503 "IP pending".
 *    The launch code needs to save the IP it gets from the cloud provider.
 * 2. `machine.quality_tier` doesn't exist either (the column is
 *    `streaming_quality`), so the quality always falls back to 'high'.
 * 3. /streaming-status doesn't really check Sunshine — it assumes that a
 *    running machine means a running Sunshine.
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { query } from '../../config/database';
import { authMiddleware } from '../middleware/auth';

const router = Router();

/**
 * GET /api/streaming/:machineId
 * Everything needed to connect to a RUNNING machine.
 * Passing `authMiddleware` as the second argument runs the login check for
 * this route only, before the handler function.
 */
router.get('/:machineId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;
    const userId = (req as any).userId;

    // Find the machine only if it's mine AND running — you can't stream
    // from a stopped machine.
    const machineResult = await query(
      'SELECT * FROM machines WHERE id = $1 AND user_id = $2 AND status = $3',
      [machineId, userId, 'running']
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Machine not found or not running',
        code: 'MACHINE_NOT_FOUND', // a stable code the frontend can check, unlike the wording of `error`
      });
    }

    const machine = machineResult.rows[0];

    // A freshly launched machine may not have a public IP address yet.
    // (See KNOWN ISSUE 1 — with the current schema this is always 'pending'.)
    const ipAddress = machine.ip_address || 'pending';

    if (ipAddress === 'pending') {
      // 503 + retryAfter tells the frontend "try again in 30 seconds".
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
      machine.quality_tier || 'high' // see KNOWN ISSUE 2
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
 * What to type into the Moonlight app, plus download links for each platform.
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

    // Moonlight pairs with Sunshine using a one-time PIN rather than a
    // password; `format` below is informational — Moonlight is normally set
    // up by entering the host address in its "Add PC" screen.
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
 * The address of Sunshine's built-in web page on the machine, plus
 * instructions. (Mainly used to configure Sunshine and pair clients.)
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

    // Template literal (backticks): ${ipAddress} is replaced with the value.
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
 * Is streaming available right now? (See KNOWN ISSUE 3 — this is an
 * assumption based on the machine's status, not a real check.)
 */
router.get('/:machineId/streaming-status', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;
    const userId = (req as any).userId;

    // Note: no status filter here — we want to find stopped machines too,
    // so we can explain WHY streaming isn't available.
    const machineResult = await query(
      'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
      [machineId, userId]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    const machine = machineResult.rows[0];

    if (machine.status !== 'running') {
      return res.json({
        machineId,
        status: machine.status,
        streamingServiceRunning: false,
        reason: `Instance is ${machine.status}`,
      });
    }

    const ipAddress = machine.ip_address;

    // The URL a real health check would call. Not actually requested yet.
    const sunshineHealthEndpoint = `http://${ipAddress}:47990/health`;

    const streamingStatus = {
      machineId,
      instanceStatus: machine.status,
      streamingServiceRunning: true, // assumed, not verified
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
 * GET /api/streaming
 * A static catalogue of supported client apps and their trade-offs.
 * (An older comment called this /api/streaming/clients; the actual path is
 * the router root, i.e. /api/streaming.) No database needed — it's a fixed
 * list, so there's no try/catch.
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
 * Build the connection-details object returned by GET /api/streaming/:machineId.
 * A plain helper function (not a route) — it only assembles data.
 *
 * @param quality one of budget / good / high / ultra; translated to a
 *                human-readable label like "1440p 60fps"
 */
function getStreamingConnectionDetails(
  ipAddress: string,
  provider: string,
  region: string,
  quality: string
) {
  // Lookup table: quality name -> description. `Record<string, string>`
  // means "an object whose keys and values are all strings".
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
      // Unknown quality names fall back to the 'high' description.
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
