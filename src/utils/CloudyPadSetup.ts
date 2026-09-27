import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * CloudyPadSetup manages remote setup of Sunshine streaming server via CloudyPad
 * Handles SSH connection, driver installation, and Sunshine configuration
 */
export class CloudyPadSetup {
  private ipAddress: string;
  private keyPath: string;
  private username: string;
  private quality: string;
  private region: string;

  constructor(
    ipAddress: string,
    quality: string,
    region: string,
    keyPath: string = '/root/.ssh/cloudgaming-key.pem',
    username: string = 'Administrator'
  ) {
    this.ipAddress = ipAddress;
    this.quality = quality;
    this.region = region;
    this.keyPath = keyPath;
    this.username = username;
  }

  /**
   * Main orchestration: Wait for instance, install drivers, setup CloudyPad
   */
  async setup(): Promise<{ sunshineUrl: string; status: string }> {
    try {
      console.log(`[CloudyPad] Starting setup for ${this.ipAddress}`);

      // 1. Wait for instance to be reachable
      await this.waitForInstanceReady();
      console.log('[CloudyPad] Instance is reachable');

      // 2. Install GPU drivers (NVIDIA/AMD)
      await this.installGPUDrivers();
      console.log('[CloudyPad] GPU drivers installed');

      // 3. Download and install CloudyPad
      await this.installCloudyPad();
      console.log('[CloudyPad] CloudyPad installed');

      // 4. Configure Sunshine with quality settings
      await this.configureSunshine();
      console.log('[CloudyPad] Sunshine configured');

      // 5. Install gaming clients (Battle.net, Steam, etc.)
      await this.installGamingClients();
      console.log('[CloudyPad] Gaming clients installed');

      // 6. Start Sunshine service
      await this.startSunshine();
      console.log('[CloudyPad] Sunshine service started');

      const sunshineUrl = `http://${this.ipAddress}:47990`;
      console.log(`[CloudyPad] Setup complete - Sunshine web UI: ${sunshineUrl}`);

      return {
        sunshineUrl,
        status: 'ready',
      };
    } catch (error) {
      console.error('[CloudyPad] Setup failed:', error);
      throw error;
    }
  }

  /**
   * Wait for Windows instance SSH to be ready (max 10 minutes)
   */
  private async waitForInstanceReady(): Promise<void> {
    const maxRetries = 60;
    const retryDelayMs = 10000; // 10 seconds

    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.executeRemoteCommand('echo ready');
        return;
      } catch (error) {
        if (i === maxRetries - 1) {
          throw new Error(`Instance ${this.ipAddress} did not become ready after ${maxRetries * retryDelayMs / 1000}s`);
        }
        console.log(`[CloudyPad] Waiting for instance... (attempt ${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
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
        timeout: 300000, // 5 minutes
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
