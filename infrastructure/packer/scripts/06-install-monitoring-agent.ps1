# Install CloudGaming Hub monitoring agent for performance metrics

Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
$ProgressPreference = 'SilentlyContinue'

Write-Host "Installing CloudGaming Hub monitoring agent..."

$agentDir = 'C:\Program Files\CloudGaming-Agent'
$agentExe = "$agentDir\agent.exe"

try {
    # Create directory
    if (-not (Test-Path $agentDir)) {
        New-Item -ItemType Directory -Path $agentDir -Force | Out-Null
    }

    # Download monitoring agent
    # This would be hosted in your repository or S3 bucket
    $agentUrl = 'https://github.com/reganireland-source/cloudgaming/releases/download/latest/monitoring-agent.exe'

    Write-Host "Downloading monitoring agent..."
    # Uncomment when agent is available
    # Invoke-WebRequest -Uri $agentUrl -OutFile $agentExe -Timeout 300

    # For now, create a placeholder that gathers system metrics
    Write-Host "Monitoring agent setup (placeholder - requires agent binary)"

    # Create performance metrics collection script
    $metricsScript = @"
# CloudGaming performance metrics collector
# Runs as scheduled task to collect system metrics
param(
    [string]\$ApiEndpoint = 'http://localhost:3001/api/performance'
)

\$metrics = @{
    timestamp = Get-Date -Format 'o'
    cpuUsage = (Get-WmiObject -Class Win32_Processor).LoadPercentage
    memoryUsage = ((Get-WmiObject -Class Win32_OperatingSystem).TotalVisibleMemorySize - (Get-WmiObject -Class Win32_OperatingSystem).FreePhysicalMemory) / 1024
    gpuUsage = 0  # Would require GPU-specific monitoring tools
    networkLatency = (Test-Connection -ComputerName 8.8.8.8 -Count 1).ResponseTime
    streamingFps = 60  # Would be reported by Sunshine
    frameDrops = 0  # Would be reported by Sunshine
}

# Send metrics to CloudGaming API
try {
    Invoke-WebRequest -Uri \$ApiEndpoint -Method POST -Body (\$metrics | ConvertTo-Json) -ContentType 'application/json'
} catch {
    Write-Warning "Failed to send metrics: \$_"
}
"@

    Set-Content -Path "$agentDir\collect-metrics.ps1" -Value $metricsScript

    # Create scheduled task for metrics collection (every minute)
    $taskName = "CloudGaming-Collect-Metrics"
    $taskPath = "\CloudGaming\"

    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-File `"$agentDir\collect-metrics.ps1`""
    $trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 1) -Once -At (Get-Date)
    $principal = New-ScheduledTaskPrincipal -UserID "SYSTEM" -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

    Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath `
        -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Force | Out-Null

    Write-Host "Performance metrics collection scheduled"

} catch {
    Write-Warning "Failed to install monitoring agent: $_"
}

Write-Host "Monitoring agent setup complete"
