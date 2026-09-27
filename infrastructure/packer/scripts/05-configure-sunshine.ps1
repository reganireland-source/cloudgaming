# Configure Sunshine auto-start and default settings

Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
$ProgressPreference = 'SilentlyContinue'

Write-Host "Configuring Sunshine streaming server..."

$sunshineDir = 'C:\Program Files\Sunshine'
$configDir = "$sunshineDir\config"
$configFile = "$configDir\sunshine.conf"

# Create config directory
if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}

# Default Sunshine configuration (good quality balance)
$sunshineConfig = @"
# CloudGaming Hub - Sunshine Configuration
# Generated during AMI build for streaming optimization

# Video settings (High Quality - 1440p 60fps)
resolution_width = 2560
resolution_height = 1440
refresh_rate = 60
bitrate_mode = variable
bitrate = 25000  # 25 Mbps

# Encoder settings
encoder = auto
gpu_idx = 0
colorspace = 709

# Audio settings
audio_channels = 2
audio_frequency = 48000

# Network
port = 47998
upnp = true
origin_web_ui_allowed = 0.0.0.0/0

# Streaming options
grayScaleIdr = false
autogpu = true
key_repeat_delay = 10
gamepad_version = 5

# Performance
virtual_surround = windows_sonic
max_cbs = 3

# Logging
log_level = info

# Web UI settings
address_family = both
"@

# Write config file
try {
    Set-Content -Path $configFile -Value $sunshineConfig -Force
    Write-Host "Sunshine configuration written to: $configFile"
} catch {
    Write-Warning "Failed to write Sunshine config: $_"
}

# Set up Sunshine service for auto-start
try {
    # Register Sunshine service if not already registered
    $sunshineExe = "$sunshineDir\sunshine.exe"

    if (Test-Path $sunshineExe) {
        # Create scheduled task to start Sunshine at startup
        $taskName = "CloudGaming-Sunshine-AutoStart"
        $taskPath = "\CloudGaming\"

        # Remove existing task if it exists
        Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false -ErrorAction SilentlyContinue

        # Create new scheduled task
        $action = New-ScheduledTaskAction -Execute $sunshineExe -Argument ""
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $principal = New-ScheduledTaskPrincipal -UserID "SYSTEM" -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

        Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath `
            -Action $action -Trigger $trigger -Principal $principal `
            -Settings $settings -Force | Out-Null

        Write-Host "Scheduled task created for Sunshine auto-start"

        # Also create service entry for Windows services management
        & sc.exe create "Sunshine" binpath= "$sunshineExe" start= auto `
            DisplayName= "CloudGaming Hub - Sunshine Streaming" 2>&1 | Out-Null

        Write-Host "Windows service created for Sunshine"

    } else {
        Write-Warning "Sunshine executable not found - service setup skipped"
    }

} catch {
    Write-Warning "Failed to configure Sunshine auto-start: $_"
}

# Create helper scripts
$sunshineStartScript = @"
# Start Sunshine streaming server
`$sunshineExe = 'C:\Program Files\Sunshine\sunshine.exe'
if (Test-Path `$sunshineExe) {
    Write-Host 'Starting Sunshine...'
    & `$sunshineExe
} else {
    Write-Error 'Sunshine executable not found'
}
"@

Set-Content -Path "$sunshineDir\start-sunshine.ps1" -Value $sunshineStartScript -Force

Write-Host "Sunshine configuration complete"
Write-Host "Sunshine will auto-start on next system boot"
Write-Host "Web UI will be available at: http://<instance-ip>:47990"
Write-Host "Moonlight clients can connect to: <instance-ip>:47998"
