# Install Windows updates for system stability

Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
$ProgressPreference = 'SilentlyContinue'

Write-Host "Installing Windows Updates..."

try {
    # Install Windows Update support module
    Install-Module -Name PSWindowsUpdate -Force -Confirm:$false -ErrorAction SilentlyContinue

    # Get available updates
    $updates = Get-WindowsUpdate -ErrorAction SilentlyContinue

    if ($updates) {
        Write-Host "Found $($updates.Count) Windows updates - installing..."
        Install-WindowsUpdate -AcceptAll -IgnoreReboot -ErrorAction SilentlyContinue
        Write-Host "Windows updates installed"
    } else {
        Write-Host "System is up to date"
    }

} catch {
    Write-Warning "Could not install Windows updates via PSWindowsUpdate module"
    Write-Host "System may require manual updates"
}

Write-Host "Windows Update check complete"
