# Install gaming clients (Battle.net, Steam, etc.)

Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
$ProgressPreference = 'SilentlyContinue'

Write-Host "Installing gaming clients..."

# Create Gaming directory
$gamingDir = 'C:\Games'
if (-not (Test-Path $gamingDir)) {
    New-Item -ItemType Directory -Path $gamingDir -Force | Out-Null
}

# Function to download and install with retry logic
function Install-GameClient {
    param(
        [string]$Name,
        [string]$Url,
        [string]$InstallerPath,
        [string]$InstallDir,
        [string[]]$InstallArgs
    )

    try {
        Write-Host "Installing $Name..."
        Write-Host "Downloading from: $Url"

        Invoke-WebRequest -Uri $Url -OutFile $InstallerPath -Timeout 600 -ErrorAction Stop

        Write-Host "Running $Name installer..."
        Start-Process -FilePath $InstallerPath -ArgumentList $InstallArgs -NoNewWindow -Wait

        Write-Host "$Name installation complete"
        Remove-Item -Path $InstallerPath -Force -ErrorAction SilentlyContinue

    } catch {
        Write-Warning "Failed to install $Name - installation may need to be completed manually"
        Write-Warning "Error: $_"
    }
}

# Battle.net Launcher (primary gaming platform)
Install-GameClient -Name "Battle.net" `
    -Url "https://www.battle.net/download/getInstaller?os=win&installer=Agent-Setup.exe" `
    -InstallerPath "C:\battlenet-installer.exe" `
    -InstallDir "C:\Program Files (x86)\Battle.net" `
    -InstallArgs @("/S", "/D=C:\Program Files (x86)\Battle.net")

# Steam (additional game library)
Install-GameClient -Name "Steam" `
    -Url "https://steamcdn-a.akamaihd.net/client/installer/SteamSetup.exe" `
    -InstallerPath "C:\steam-installer.exe" `
    -InstallDir "C:\Program Files (x86)\Steam" `
    -InstallArgs @("/S", "/D=C:\Program Files (x86)\Steam")

# Epic Games Launcher
Install-GameClient -Name "Epic Games Launcher" `
    -Url "https://launcher-public-service-prod06.ol.epicgames.com/download/EpicGamesLauncher.msi" `
    -InstallerPath "C:\epicgames-installer.msi" `
    -InstallDir "C:\Program Files\Epic Games" `
    -InstallArgs @("/i", "C:\epicgames-installer.msi", "/qn")

# Create gaming library directory structure
$libraryPaths = @(
    "C:\Games\Warcraft",
    "C:\Games\Diablo",
    "C:\Games\Overwatch",
    "C:\Games\Steam-Games",
    "C:\Games\Epic-Games"
)

foreach ($path in $libraryPaths) {
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        Write-Host "Created directory: $path"
    }
}

Write-Host "Gaming clients installation complete"
Write-Host "Note: Client installers may continue in background - allow 15+ minutes for full setup"
