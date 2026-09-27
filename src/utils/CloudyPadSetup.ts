import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config/env';

const execAsync = promisify(exec);

/**
 * CloudyPadSetup manages remote setup of Sunshine streaming server via CloudyPad
 * Handles SSH connection, driver installation, and Sunshine configuration
 *
 * Configuration via environment variables:
 * - SSH_KEY_PATH: Path to private key for Windows instances (default: /root/.ssh/cloudgaming-key.pem)
 * - SSH_USERNAME: Windows username (default: Administrator)
 * - SSH_TIMEOUT_MS: SSH command timeout (default: 300000ms / 5min)
 * - SSH_RETRY_DELAY_MS: Delay between connection retries (default: 10000ms / 10sec)
 */
export class CloudyPadSetup {
  private ipAddress: string;
  private keyPath: string;
  private username: string;
  private quality: string;
  private region: string;
  private timeoutMs: number;
  private retryDelayMs: number;
  private machineId?: string;
  private statusCallback?: (stage: string, progress: number, message: string) => Promise<void>;

  constructor(
    ipAddress: string,
    quality: string,
    region: string,
    keyPath?: string,
    username?: string,
    machineId?: string,
    statusCallback?: (stage: string, progress: number, message: string) => Promise<void>
  ) {
    this.ipAddress = ipAddress;
    this.quality = quality;
    this.region = region;
    this.machineId = machineId;
    this.statusCallback = statusCallback;
    // Use provided values or fall back to environment variables
    this.keyPath = keyPath || env.SSH_KEY_PATH;
    this.username = username || env.SSH_USERNAME;
    this.timeoutMs = env.SSH_TIMEOUT_MS;
    this.retryDelayMs = env.SSH_RETRY_DELAY_MS;

    // Validate SSH key exists
    if (!fs.existsSync(this.keyPath)) {
      console.warn(
        `[CloudyPad] Warning: SSH key not found at ${this.keyPath}. ` +
        `Setup will fail. Ensure key exists or set SSH_KEY_PATH environment variable.`
      );
    }
  }

  private async reportStatus(stage: string, progress: number, message: string): Promise<void> {
    if (this.statusCallback) {
      await this.statusCallback(stage, progress, message);
    }
  }

  /**
   * Main orchestration: Wait for instance, install drivers, setup CloudyPad
   */
  async setup(): Promise<{ sunshineUrl: string; status: string }> {
    try {
      console.log(`[CloudyPad] Starting setup for ${this.ipAddress}`);
      await this.reportStatus('initializing', 10, 'Initializing setup orchestrator...');

      // 1. Wait for instance to be reachable
      await this.reportStatus('waiting_for_instance', 15, 'Waiting for instance to become reachable via SSH...');
      await this.waitForInstanceReady();
      console.log('[CloudyPad] Instance is reachable');
      await this.reportStatus('waiting_for_instance', 20, 'Instance is reachable');

      // 2. Install GPU drivers (NVIDIA/AMD)
      await this.reportStatus('installing_drivers', 25, 'Installing GPU drivers (NVIDIA/AMD)...');
      await this.installGPUDrivers();
      console.log('[CloudyPad] GPU drivers installed');
      await this.reportStatus('installing_drivers', 40, 'GPU drivers installed successfully');

      // 3. Download and install CloudyPad
      await this.reportStatus('installing_cloudypad', 45, 'Downloading and installing CloudyPad...');
      await this.installCloudyPad();
      console.log('[CloudyPad] CloudyPad installed');
      await this.reportStatus('installing_cloudypad', 60, 'CloudyPad installed with Sunshine');

      // 4. Configure Sunshine with quality settings
      await this.reportStatus('configuring_sunshine', 65, `Configuring Sunshine for ${this.quality} quality...`);
      await this.configureSunshine();
      console.log('[CloudyPad] Sunshine configured');
      await this.reportStatus('configuring_sunshine', 75, 'Sunshine configuration complete');

      // 5. Install gaming clients (Battle.net, Steam, etc.)
      await this.reportStatus('installing_clients', 80, 'Installing gaming clients (Battle.net, Steam, Epic Games)...');
      await this.installGamingClients();
      console.log('[CloudyPad] Gaming clients installed');
      await this.reportStatus('installing_clients', 85, 'Gaming clients installation started');

      // 6. Start Sunshine service
      await this.reportStatus('starting_service', 90, 'Starting Sunshine streaming service...');
      await this.startSunshine();
      console.log('[CloudyPad] Sunshine service started');
      await this.reportStatus('starting_service', 95, 'Sunshine service started successfully');

      const sunshineUrl = `http://${this.ipAddress}:47990`;
      console.log(`[CloudyPad] Setup complete - Sunshine web UI: ${sunshineUrl}`);

      // Generate a random 6-digit PIN for Sunshine pairing
      const sunshinePin = Math.floor(100000 + Math.random() * 900000).toString();

      await this.reportStatus('complete', 100, 'Setup complete and streaming service is ready!');

      return {
        sunshineUrl,
        status: 'ready',
      };
    } catch (error) {
      console.error('[CloudyPad] Setup failed:', error);
      await this.reportStatus('failed', 0, `Setup failed: ${error}`);
      throw error;
    }
  }

  /**
   * Wait for Windows instance SSH to be ready
   * Retries based on SSH_TIMEOUT_MS and SSH_RETRY_DELAY_MS environment variables
   */
  private async waitForInstanceReady(): Promise<void> {
    const maxRetries = Math.ceil(this.timeoutMs / this.retryDelayMs);
    const totalWaitMinutes = (maxRetries * this.retryDelayMs) / 60000;

    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.executeRemoteCommand('echo ready');
        console.log(`[CloudyPad] Instance ready after ${(i * this.retryDelayMs) / 1000}s`);
        return;
      } catch (error) {
        if (i === maxRetries - 1) {
          throw new Error(
            `Instance ${this.ipAddress} did not become ready after ${totalWaitMinutes.toFixed(1)} minutes. ` +
            `Last error: ${error}`
          );
        }
        console.log(
          `[CloudyPad] Waiting for instance... (attempt ${i + 1}/${maxRetries}, ` +
          `timeout in ${totalWaitMinutes.toFixed(1)} min)`
        );
        await new Promise(resolve => setTimeout(resolve, this.retryDelayMs));
      }
    }
  }

  /**
   * Install NVIDIA GPU drivers via Windows Update or direct download
   */
  private async installGPUDrivers(): Promise<void> {
    const driverScript = `
@echo off
echo Installing NVIDIA GPU drivers...
REM Check GPU model
wmic path win32_videocontroller get name | findstr /i "NVIDIA"
if %ERRORLEVEL% EQU 0 (
    echo Detected NVIDIA GPU
    REM Download latest NVIDIA driver
    powershell -Command "
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -Uri 'https://www.nvidia.com/Download/driverResults.aspx/207176' -OutFile 'C:\\nvidia-driver.exe'
      C:\\nvidia-driver.exe -s -noreboot
    "
) else (
    echo No NVIDIA GPU detected, checking for AMD
    wmic path win32_videocontroller get name | findstr /i "AMD"
    if %ERRORLEVEL% EQU 0 (
        echo Detected AMD GPU
        REM Similar for AMD drivers
    )
)
`;
    await this.executeRemoteCommand(driverScript);
  }

  /**
   * Download and run CloudyPad installer
   * CloudyPad handles Sunshine installation and configuration
   */
  private async installCloudyPad(): Promise<void> {
    const cloudypadScript = `
powershell -Command "
  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
  \$ProgressPreference = 'SilentlyContinue'

  # Download CloudyPad installer from official repository
  \$cloudypadUrl = 'https://github.com/ReplayCoding/cloudy-pad/releases/download/latest/cloudypad-installer.exe'
  \$installerPath = 'C:\\cloudypad-installer.exe'

  Write-Host 'Downloading CloudyPad...'
  Invoke-WebRequest -Uri \$cloudypadUrl -OutFile \$installerPath

  # Run installer with automatic configuration
  Write-Host 'Installing CloudyPad and Sunshine...'
  & \$installerPath /S /D=C:\\CloudyPad

  # Wait for installation to complete
  Start-Sleep -Seconds 30
"
`;
    await this.executeRemoteCommand(cloudypadScript);
  }

  /**
   * Configure Sunshine streaming quality settings
   */
  private async configureSunshine(): Promise<void> {
    const qualitySettings = this.getQualityConfig();

    const sunshineConfigScript = `
powershell -Command "
  \$configPath = 'C:\\Program Files\\Sunshine\\config\\sunshine.conf'

  # Create or update Sunshine configuration
  @'
# Sunshine Configuration - CloudGaming Hub
# Auto-generated from quality setting: ${this.quality}

resolution_width = ${qualitySettings.width}
resolution_height = ${qualitySettings.height}
refresh_rate = ${qualitySettings.fps}
bitrate_mode = ${qualitySettings.bitrate > 0 ? 'constant' : 'variable'}
bitrate = ${qualitySettings.bitrate}
grayScaleIdr = false
encoderCscColorSpace = 0
encoderCscFullRangeFlag = false

# Audio settings
audio_channels = 2
audio_frequency = 48000

# Network settings
inbound_port = 47998
outbound_port = 47998

# Streaming options
autogpu = true
encoder = auto
'@ | Out-File -FilePath \$configPath -Encoding utf8

  Write-Host 'Sunshine configured with settings:'
  Write-Host 'Resolution: ${qualitySettings.width}x${qualitySettings.height}'
  Write-Host 'FPS: ${qualitySettings.fps}'
  Write-Host 'Bitrate: ${qualitySettings.bitrate} Mbps'
"
`;
    await this.executeRemoteCommand(sunshineConfigScript);
  }

  /**
   * Install gaming clients (Battle.net, Steam, etc.)
   */
  private async installGamingClients(): Promise<void> {
    const clientScript = `
powershell -Command "
  Write-Host 'Installing gaming clients...'

  # Battle.net Launcher
  \$battlenetUrl = 'https://www.battle.net/download/getInstaller?os=win&installer=Agent-Setup.exe'
  Invoke-WebRequest -Uri \$battlenetUrl -OutFile 'C:\\battlenet-installer.exe' -ProgressAction SilentlyContinue
  & 'C:\\battlenet-installer.exe' /S /D=C:\\Program Files\\Battle.net

  # Steam (optional, for additional game library)
  # \$steamUrl = 'https://steamcdn-a.akamaihd.net/client/installer/SteamSetup.exe'
  # Invoke-WebRequest -Uri \$steamUrl -OutFile 'C:\\steam-installer.exe' -ProgressAction SilentlyContinue
  # & 'C:\\steam-installer.exe' /S /D=C:\\Program Files\\Steam

  Write-Host 'Gaming clients installation started (running in background)'
"
`;
    await this.executeRemoteCommand(clientScript);
  }

  /**
   * Start Sunshine service
   */
  private async startSunshine(): Promise<void> {
    const startScript = `
powershell -Command "
  # Enable and start Sunshine service
  Set-Service -Name 'Sunshine' -StartupType Automatic -ErrorAction SilentlyContinue
  Start-Service -Name 'Sunshine' -ErrorAction SilentlyContinue

  # Wait for service to start
  Start-Sleep -Seconds 5

  # Verify service is running
  \$service = Get-Service -Name 'Sunshine' -ErrorAction SilentlyContinue
  if (\$service.Status -eq 'Running') {
    Write-Host 'Sunshine service is running'
  } else {
    Write-Host 'Starting Sunshine application directly...'
    & 'C:\\Program Files\\Sunshine\\sunshine.exe' &
  }
"
`;
    await this.executeRemoteCommand(startScript);
  }

  /**
   * Execute command on remote Windows instance via SSH
   * Uses timeout from SSH_TIMEOUT_MS environment variable
   */
  private async executeRemoteCommand(command: string): Promise<string> {
    const sshCommand = `
ssh -i ${this.keyPath} \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=10 \
  ${this.username}@${this.ipAddress} \
  "${command.replace(/"/g, '\\"')}"
`;

    try {
      const { stdout, stderr } = await execAsync(sshCommand, {
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      if (stderr && !stderr.includes('Warning')) {
        console.warn(`[CloudyPad SSH] ${stderr}`);
      }

      return stdout;
    } catch (error: any) {
      throw new Error(`SSH command failed: ${error.message}`);
    }
  }

  /**
   * Map quality level to Sunshine configuration
   */
  private getQualityConfig(): {
    width: number;
    height: number;
    fps: number;
    bitrate: number;
    gbPerHour: number;
  } {
    const qualityMap: Record<
      string,
      { width: number; height: number; fps: number; bitrate: number; gbPerHour: number }
    > = {
      budget: {
        width: 1280,
        height: 720,
        fps: 30,
        bitrate: 5,
        gbPerHour: 2.25,
      },
      good: {
        width: 1920,
        height: 1080,
        fps: 60,
        bitrate: 12,
        gbPerHour: 5.4,
      },
      high: {
        width: 2560,
        height: 1440,
        fps: 60,
        bitrate: 25,
        gbPerHour: 11.25,
      },
      ultra: {
        width: 3840,
        height: 2160,
        fps: 60,
        bitrate: 50,
        gbPerHour: 22.5,
      },
    };

    return qualityMap[this.quality.toLowerCase()] || qualityMap.good;
  }
}

/**
 * Get streaming connection details for a configured machine
 */
export interface StreamingConnectionDetails {
  protocol: 'sunshine' | 'moonlight';
  sunshineWebUrl?: string;
  moonlightConnectionString?: string;
  ipAddress: string;
  port: number;
  connectionInstructions: string;
}

export function getStreamingConnectionDetails(
  ipAddress: string,
  machineProvider: string
): StreamingConnectionDetails {
  return {
    protocol: 'sunshine',
    sunshineWebUrl: `http://${ipAddress}:47990`,
    ipAddress,
    port: 47998,
    connectionInstructions: `
1. Open Sunshine Web UI: http://${ipAddress}:47990
2. Or use Moonlight client with host: ${ipAddress}:47998
3. Default credentials will be displayed in Sunshine setup
4. For optimal performance, use wired connection
5. Monitor performance via CloudGaming Hub performance portal
    `,
  };
}
