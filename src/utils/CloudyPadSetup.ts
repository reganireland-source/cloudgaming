/**
 * ============================================================================
 * src/utils/CloudyPadSetup.ts — TURNING A BLANK CLOUD VM INTO A GAMING RIG
 * ============================================================================
 *
 * WHAT THIS DOES
 * --------------
 * A freshly launched Windows VM can't stream games yet. This class connects
 * to it over SSH (a secure remote command line) and runs a sequence of
 * setup scripts on it:
 *   1. wait until the machine has booted and accepts SSH
 *   2. install GPU drivers
 *   3. install CloudyPad/Sunshine (the streaming server)
 *   4. write Sunshine's config for the chosen quality (resolution/fps/bitrate)
 *   5. install game launchers (Battle.net; Steam is commented out)
 *   6. start the Sunshine service
 * It's used by MachineService.launchMachine (via setupSunshine) and
 * MachineService.updateStreamingQuality (step 4 only).
 *
 * HOW IT RUNS REMOTE COMMANDS
 * ---------------------------
 * It doesn't use an SSH library. It builds an `ssh ...` command line as text
 * and runs it with Node's `exec`, exactly as if you'd typed it into a
 * terminal on the server. That means the machine running the backend must
 * have the `ssh` program installed and the private key file present at
 * SSH_KEY_PATH (see src/config/env.ts).
 *
 * PROGRESS REPORTING
 * ------------------
 * An optional `statusCallback` is called at each stage (with a stage name,
 * a 0–100 progress number and a message). That's designed to feed the
 * frontend's progress bar via the setup_status table — but nothing passes
 * a callback in yet, so today progress only appears in the server logs.
 *
 * ⚠️  IMPORTANT: THE SCRIPTS BELOW ARE UNTESTED AGAINST A REAL MACHINE
 * ---------------------------------------------------------------------
 * Treat them as a first draft. Known problems:
 *   - The CloudyPad download URL (github.com/ReplayCoding/cloudy-pad) is
 *     not the real CloudyPad project, and the real CloudyPad
 *     (github.com/PierreBeucher/cloudypad) is a command-line tool you run
 *     on YOUR computer to create cloud machines — not a Windows installer.
 *     Installing Sunshine directly (its official Windows installer) or baking
 *     it into the Packer image (infrastructure/packer/) is the realistic path.
 *   - The NVIDIA URL points at a web page, not a driver .exe.
 *   - Windows' OpenSSH server runs commands in cmd.exe by default; sending a
 *     multi-line batch script or a multi-line `powershell -Command "..."` as
 *     one SSH argument is unlikely to run as intended.
 *   - A pairing PIN is generated in setup() but never returned or used.
 *   - `path`, `region` and `machineId` are stored/imported but unused.
 * ============================================================================
 */

// `exec` runs a shell command from Node.js (like typing it in a terminal).
import { exec } from 'child_process';
// `promisify` converts old callback-style functions into Promise-returning
// ones, so we can `await` them.
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config/env';

// execAsync(cmd) returns a Promise of { stdout, stderr } — the command's
// normal output and error output.
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
  // Everything the setup needs, stored on the object so every method can
  // use it via `this.`. `?` marks optional fields.
  private ipAddress: string;
  private keyPath: string;
  private username: string;
  private quality: string;
  private region: string;
  private timeoutMs: number;
  private retryDelayMs: number;
  private machineId?: string;
  private statusCallback?: (stage: string, progress: number, message: string) => Promise<void>;

  /**
   * @param ipAddress      the machine to connect to
   * @param quality        'budget' | 'good' | 'high' | 'ultra'
   * @param region         cloud region (stored, currently unused)
   * @param keyPath        override SSH_KEY_PATH for this run (optional)
   * @param username       override SSH_USERNAME (optional)
   * @param machineId      our id for the machine (optional, currently unused)
   * @param statusCallback function called with (stage, progress, message) at
   *                       each step — e.g. to save progress for the UI (optional)
   */
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

    // Warn early (in the logs) if the private key file isn't there — every
    // SSH attempt would fail without it. A warning rather than an error so
    // that creating the object never crashes the caller.
    if (!fs.existsSync(this.keyPath)) {
      console.warn(
        `[CloudyPad] Warning: SSH key not found at ${this.keyPath}. ` +
        `Setup will fail. Ensure key exists or set SSH_KEY_PATH environment variable.`
      );
    }
  }

  /**
   * Pass a progress update to the callback, if one was provided. Called
   * before and after every stage in setup().
   */
  private async reportStatus(stage: string, progress: number, message: string): Promise<void> {
    if (this.statusCallback) {
      await this.statusCallback(stage, progress, message);
    }
  }

  /**
   * Main orchestration: Wait for instance, install drivers, setup CloudyPad
   *
   * Runs the six stages strictly in order — each `await` waits for the
   * previous step to finish before starting the next. If ANY stage throws,
   * we jump to the `catch`, report 'failed', and re-throw so the caller
   * knows. The progress numbers (10, 15, 20 ... 100) are rough milestones
   * for a progress bar, not measured percentages.
   *
   * @returns the Sunshine web address and 'ready' when everything succeeded
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
      // (100000 + a random number below 900000 always gives 6 digits.)
      // ⚠️ Not used anywhere yet: it isn't returned, reported, or given to
      // Sunshine. Real Sunshine pairing shows its own PIN in the client app.
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
  //
  // A new VM takes a few minutes to boot. We repeatedly try a harmless
  // command (`echo ready`) until one succeeds:
  //   attempts = total timeout ÷ delay between attempts
  //   (defaults: 300000 ms ÷ 10000 ms = 30 attempts, 10 s apart ≈ 5 minutes)
  // Math.ceil rounds UP so a partial attempt still counts.
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
        // "Sleep" for retryDelayMs. setTimeout calls resolve() after the
        // delay; wrapping it in a Promise lets us `await` the pause.
        await new Promise(resolve => setTimeout(resolve, this.retryDelayMs));
      }
    }
  }

  /**
   * Install NVIDIA GPU drivers via Windows Update or direct download
   *
   * The text in backticks below is a Windows batch script sent to the
   * machine as-is: it checks the graphics card name with `wmic`, and if it's
   * NVIDIA, downloads and silently runs a driver installer (-s = silent,
   * -noreboot = don't restart). The AMD branch is a placeholder.
   * ⚠️ The download URL is a web page, not an installer (see file header).
   * (The Packer image in infrastructure/packer/ also installs drivers, so on
   * that image this step should be redundant.)
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
   *
   * A PowerShell script: allow scripts to run (Set-ExecutionPolicy), hide
   * the slow progress bar, download the installer, run it silently (/S)
   * into C:\CloudyPad, then wait 30 s for it to finish.
   * Note the `\$` in the script: inside a JavaScript template string `${...}`
   * would be treated as a JS variable, so PowerShell's own `$variables` are
   * escaped with a backslash to reach Windows unchanged.
   * ⚠️ Wrong URL / wrong kind of tool — see the file header.
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
   *
   * Looks up the resolution/fps/bitrate for the chosen quality, then writes
   * a complete sunshine.conf file on the machine. Unlike the PowerShell
   * `\$variables`, the `${qualitySettings.width}` parts here are real
   * JavaScript placeholders — filled in with our values BEFORE the script is
   * sent. `@' ... '@` is a PowerShell "here-string" (a multi-line text block),
   * piped into Out-File to create the file.
   * Also called on its own by MachineService.updateStreamingQuality.
   */
  private async configureSunshine(): Promise<void> {
    const qualitySettings = this.getQualityConfig();

    const sunshineConfigScript = `
powershell -Command "
  \$configPath = 'C:\\Program Files\\Sunshine\\config\\sunshine.conf'

  # Create or update Sunshine configuration
  @'
# Sunshine Configuration - Gints Global Gaming Hubjob
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
   *
   * Downloads and silently installs the Battle.net launcher. Steam is
   * prepared but commented out (the lines starting with #). The user still
   * has to log in to the launcher and install games themselves.
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
   *
   * Sets the Sunshine Windows service to start automatically on every boot,
   * starts it now, waits 5 s, and checks it's running. If it isn't, falls
   * back to launching sunshine.exe directly.
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
  //
  // Builds a terminal command like:
  //   ssh -i /path/key.pem -o StrictHostKeyChecking=no ... Administrator@1.2.3.4 "<command>"
  // Options used:
  //   -i <file>                      the private key to log in with
  //   StrictHostKeyChecking=no       don't stop to ask "trust this new machine?"
  //   UserKnownHostsFile=/dev/null   don't remember machines (every VM is new)
  //     (together these skip a security check that normally detects
  //      impersonation — acceptable for throwaway VMs we just created, but
  //      worth knowing)
  //   ConnectTimeout=10              give up connecting after 10 s
  // Double quotes inside `command` are escaped (\") so they don't end the
  // quoted argument early. Only our own scripts are ever passed in here —
  // never text typed by a user — which matters, because this string is run
  // by a shell.
  //
  // @returns what the remote command printed (stdout)
  // @throws  if SSH fails or the command exits with an error
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

      // SSH prints harmless notices like "Warning: Permanently added ... to
      // the list of known hosts" on stderr; log anything else as a warning.
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
   *
   *   width × height   picture resolution in pixels
   *   fps              frames per second
   *   bitrate          video data rate in megabits per second (Mbps)
   *   gbPerHour        resulting data per hour of play:
   *                    Mbps × 3600 s ÷ 8 bits-per-byte ÷ 1000 = GB/hour
   *                    (e.g. 25 Mbps ≈ 11.25 GB/hour) — this drives egress cost
   * Unknown quality names fall back to 'good'.
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
 *
 * A standalone helper describing how a player connects (Sunshine web page
 * on port 47990, Moonlight on port 47998). Note: nothing currently imports
 * this — src/api/routes/streaming.ts has its own similar helper.
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
5. Monitor performance via Gints Global Gaming Hubjob performance portal
    `,
  };
}
