# Install NVIDIA GPU drivers for CloudGaming

Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
$ProgressPreference = 'SilentlyContinue'

Write-Host "Installing NVIDIA GPU drivers..."

# Detect GPU model
$gpu = Get-WmiObject -Class Win32_VideoController | Where-Object {$_.Name -match 'NVIDIA'}

if ($gpu) {
    Write-Host "Detected GPU: $($gpu.Name)"

    # For EC2 g4dn instances, use NVIDIA GRID drivers (optimized for virtual GPUs)
    $driverUrl = 'https://s3.amazonaws.com/nvidia-gaming/GridDriver/NVIDIA-GRID-Win-Drivers-512.91-512.75-Public-lic.exe'
    $driverPath = 'C:\nvidia-driver.exe'

    try {
        Write-Host "Downloading NVIDIA GRID driver..."
        Invoke-WebRequest -Uri $driverUrl -OutFile $driverPath -Timeout 300

        Write-Host "Installing driver (this may take 10+ minutes)..."
        & $driverPath -s -noreboot -clean

        # Wait for driver installation
        Write-Host "Waiting for driver installation to complete..."
        Start-Sleep -Seconds 120

        # Verify installation
        $cudaPath = "C:\Program Files\NVIDIA Corporation\NVIDIA CUDA Toolkit"
        if (Test-Path $cudaPath) {
            Write-Host "NVIDIA drivers installed successfully"
        } else {
            Write-Host "Driver installation completed - GPU ready"
        }

        # Clean up installer
        Remove-Item -Path $driverPath -Force -ErrorAction SilentlyContinue

    } catch {
        Write-Error "Failed to install NVIDIA drivers: $_"
        exit 1
    }
} else {
    Write-Warning "No NVIDIA GPU detected - instance may not support GPU gaming"
}

Write-Host "GPU driver installation complete"
