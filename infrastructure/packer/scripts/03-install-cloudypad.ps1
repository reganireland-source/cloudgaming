# Install CloudyPad and Sunshine streaming server

Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
$ProgressPreference = 'SilentlyContinue'

Write-Host "Installing CloudyPad and Sunshine..."

$cloudypadUrl = 'https://github.com/ReplayCoding/cloudy-pad/releases/download/latest/cloudypad-setup.exe'
$installerPath = 'C:\cloudypad-installer.exe'

try {
    Write-Host "Downloading CloudyPad installer..."
    Invoke-WebRequest -Uri $cloudypadUrl -OutFile $installerPath -Timeout 600 -ErrorAction Stop

    Write-Host "Running CloudyPad installer..."
    # CloudyPad installer includes Sunshine
    & $installerPath /S /D='C:\Program Files\Sunshine'

    Write-Host "Waiting for installation to complete..."
    Start-Sleep -Seconds 90

    # Verify Sunshine installation
    $sunshineExe = 'C:\Program Files\Sunshine\sunshine.exe'
    if (Test-Path $sunshineExe) {
        Write-Host "Sunshine installed successfully at $sunshineExe"

        # Create Sunshine config directory if it doesn't exist
        $configDir = 'C:\Program Files\Sunshine\config'
        if (-not (Test-Path $configDir)) {
            New-Item -ItemType Directory -Path $configDir -Force | Out-Null
        }

        Write-Host "CloudyPad installation complete"
    } else {
        Write-Error "Sunshine executable not found - installation may have failed"
        exit 1
    }

    # Cleanup
    Remove-Item -Path $installerPath -Force -ErrorAction SilentlyContinue

} catch {
    Write-Error "Failed to install CloudyPad: $_"
    exit 1
}

Write-Host "CloudyPad and Sunshine setup complete"
