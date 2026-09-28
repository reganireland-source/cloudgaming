# Cleanup and optimization for AMI

Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
$ProgressPreference = 'SilentlyContinue'

Write-Host "Optimizing AMI for deployment..."

try {
    # Clear temp files
    Write-Host "Clearing temporary files..."
    Remove-Item -Path "C:\Temp\*" -Force -Recurse -ErrorAction SilentlyContinue
    Remove-Item -Path "C:\Windows\Temp\*" -Force -Recurse -ErrorAction SilentlyContinue
    Remove-Item -Path "C:\Users\*\AppData\Local\Temp\*" -Force -Recurse -ErrorAction SilentlyContinue

    # Clear Windows Update cache
    Write-Host "Clearing Windows Update cache..."
    Dism.exe /online /Cleanup-Image /StartComponentCleanup /ResetBase

    # Compress drive
    Write-Host "Compressing system drive..."
    Compact.exe /CompactOs:always

    # Defragment
    Write-Host "Optimizing disk..."
    Optimize-Volume -DriveLetter C -Defrag -Verbose | Out-Null

    # Clear Event logs
    Write-Host "Clearing Event logs..."
    Get-EventLog -LogName * | Where-Object { $_.Entries.Count -gt 0 } | ForEach-Object {
        Clear-EventLog -LogName $_.Log -ErrorAction SilentlyContinue
    }

    # Cleanup Windows Update files
    Write-Host "Cleanup Windows files..."
    Remove-Item -Path "C:\Windows\SoftwareDistribution\Download\*" -Force -Recurse -ErrorAction SilentlyContinue

    # Zero unused space (for better compression)
    Write-Host "Zeroing unused space..."
    # This is typically done by EC2 Image Builder or manually

} catch {
    Write-Warning "Optimization encountered errors (non-critical): $_"
}

# Create AMI build info file
$buildInfo = @"
Gints Global Gaming Hubjob Windows AMI Build Information
===============================================

Build Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Windows Version: $(Get-WmiObject -Class Win32_OperatingSystem).Caption
System: $env:COMPUTERNAME

Pre-installed Components:
- NVIDIA GPU Drivers (GRID optimized)
- CloudyPad Streaming Framework
- Sunshine Streaming Server
- Battle.net Launcher
- Steam Client
- Epic Games Launcher
- Gints Global Gaming Hubjob Monitoring Agent

Configuration:
- Sunshine Web UI: http://<instance-ip>:47990
- Moonlight Connection: <instance-ip>:47998
- Default Quality: High (1440p 60fps 25Mbps)
- Auto-start: Enabled

Ready for Gints Global Gaming Hubjob deployment

For support: your repository on GitHub
"@

Set-Content -Path "C:\cloudgaming-build-info.txt" -Value $buildInfo

Write-Host "AMI optimization complete"
Write-Host "This AMI is ready for Gints Global Gaming Hubjob deployment"
