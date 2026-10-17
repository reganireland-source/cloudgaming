/**
 * src/providers/shared/localAgent.ts — THE WINDOWS PC'S SIDE OF "LOCAL MACHINES" (PowerShell)
 *
 * INSTALL_PS1  pasted once into an ELEVATED PowerShell on the PC (the app shows the
 *              command, with the agent's token on its command line; the script itself
 *              holds no secret). It installs Sunshine (winget) if missing, gives it a
 *              login only the PC knows, saves the agent's token where only SYSTEM and
 *              Administrators can read it, turns on Wake-on-LAN, and registers two
 *              scheduled tasks: "GGGH Agent" (SYSTEM, at boot) and "GGGH Display"
 *              (runs in the signed-in user's session, only when the agent asks).
 *
 * AGENT_PS1    the agent. It connects OUT to GGGH (HTTPS long-poll), reports status and
 *              does ONE of a fixed list of things per command: refresh, sleep, restart,
 *              shutdown, sunshine-restart, sunshine-pin, display-set, display-restore,
 *              script (only if the app has it switched on for this PC).
 *              "-Mode display" is the second task: it changes the screen (only a user
 *              session may), reading display\request.json and writing display\result.json.
 *
 * Windows PowerShell 5.1 compatible (the one every Windows 11 has). No backticks or
 * "${" anywhere (String.raw template).
 */

export const AGENT_PS1 = String.raw`# GGGH agent for a local Windows PC. Connects out to GGGH; opens nothing.
param([string]$Mode = 'service')
$ErrorActionPreference = 'Stop'
$AgentVersion = '1'
$Dir = Join-Path $env:ProgramData 'GGGH'
$DispDir = Join-Path $Dir 'display'
$Log = Join-Path $Dir 'agent.log'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Log($m) {
  try {
    Add-Content -Path $Log -Value ('{0} {1}' -f (Get-Date -Format 's'), $m)
    if ((Get-Item $Log).Length -gt 400KB) { Move-Item $Log ($Log + '.old') -Force }
  } catch { }
}

# ---------------------------------------------------------------------------
# Screen (runs in the signed-in user's session: -Mode display)
# ---------------------------------------------------------------------------
if ($Mode -eq 'display') {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
public struct DispMode {
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
  public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
  public int dmFields;
  public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
  public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
  public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
  public int dmDisplayFlags; public int dmDisplayFrequency;
  public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
  public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
}
public static class Disp {
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DispMode dm);
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern int ChangeDisplaySettingsEx(string dev, ref DispMode dm, IntPtr hwnd, int flags, IntPtr lp);
}
'@
  function New-Mode { $dm = New-Object DispMode; $dm.dmSize = [int16][Runtime.InteropServices.Marshal]::SizeOf([type]'DispMode'); return $dm }
  function Get-Current { $dm = New-Mode; [void][Disp]::EnumDisplaySettings($null, -1, [ref]$dm); return $dm }
  function Get-Modes {
    $list = @(); $i = 0
    while ($true) {
      $dm = New-Mode
      if (-not [Disp]::EnumDisplaySettings($null, $i, [ref]$dm)) { break }
      if ($dm.dmBitsPerPel -ge 24) { $list += [pscustomobject]@{ w = $dm.dmPelsWidth; h = $dm.dmPelsHeight; f = $dm.dmDisplayFrequency } }
      $i++
    }
    return $list | Sort-Object w, h, f -Unique
  }
  function Apply-Mode($w, $h, $f) {
    $dm = Get-Current
    $dm.dmPelsWidth = $w; $dm.dmPelsHeight = $h; $dm.dmDisplayFrequency = $f
    $dm.dmFields = $dm.dmFields -bor 0x80000 -bor 0x100000 -bor 0x400000
    return [Disp]::ChangeDisplaySettingsEx($null, [ref]$dm, [IntPtr]::Zero, 0, [IntPtr]::Zero)
  }
  function Pick($modes, $w, $h, $fps) {
    $exact = @($modes | Where-Object { $_.w -eq $w -and $_.h -eq $h })
    if ($exact.Count) { return [pscustomobject]@{ mode = ($exact | Sort-Object @{e={[Math]::Abs($_.f - $fps)}}, @{e={-$_.f}} | Select-Object -First 1); exact = $true } }
    $ar = $w / $h
    $same = @($modes | Where-Object { [Math]::Abs(($_.w / $_.h) - $ar) -lt 0.02 })
    if (-not $same.Count) { return $null }
    $up = @($same | Where-Object { $_.w -ge $w })
    $pool = if ($up.Count) { $up | Sort-Object w, @{e={[Math]::Abs($_.f - $fps)}} } else { $same | Sort-Object @{e={-$_.w}}, @{e={[Math]::Abs($_.f - $fps)}} }
    return [pscustomobject]@{ mode = ($pool | Select-Object -First 1); exact = $false }
  }
  $resultPath = Join-Path $DispDir 'result.json'
  $req = Get-Content (Join-Path $DispDir 'request.json') -Raw | ConvertFrom-Json
  $ok = $false; $msg = ''
  try {
    $orig = Join-Path $DispDir 'original.json'
    if ($req.action -eq 'restore') {
      if (Test-Path $orig) {
        $o = Get-Content $orig -Raw | ConvertFrom-Json
        $rc = Apply-Mode ([int]$o.w) ([int]$o.h) ([int]$o.f)
        if ($rc -eq 0) { Remove-Item $orig -Force; $ok = $true; $msg = ('Screen put back to {0}x{1} at {2} Hz.' -f $o.w, $o.h, $o.f) } else { $msg = ('Windows refused to put the screen back (code {0}).' -f $rc) }
      } else { $ok = $true; $msg = 'The screen was already as you left it.' }
    } else {
      $w = [int]$req.width; $h = [int]$req.height; $fps = [int]$req.fps
      $cur = Get-Current
      if ($cur.dmPelsWidth -eq $w -and $cur.dmPelsHeight -eq $h) { $ok = $true; $msg = ('The screen is already {0}x{1}.' -f $w, $h) }
      else {
        $pick = Pick (Get-Modes) $w $h $fps
        if (-not $pick) {
          $msg = ('This PC offers no {0}x{1} screen mode, or one of the same shape. Add a custom resolution in the NVIDIA Control Panel (or use a virtual display), then try again.' -f $w, $h)
        } else {
          if (-not (Test-Path $orig)) { (@{ w = $cur.dmPelsWidth; h = $cur.dmPelsHeight; f = $cur.dmDisplayFrequency } | ConvertTo-Json -Compress) | Set-Content $orig -Encoding ASCII }
          $m = $pick.mode
          $rc = Apply-Mode $m.w $m.h $m.f
          if ($rc -eq 0) {
            $ok = $true
            if ($pick.exact) { $msg = ('Screen set to {0}x{1} at {2} Hz.' -f $m.w, $m.h, $m.f) }
            else { $msg = ('No exact {0}x{1}; used the closest mode of the same shape, {2}x{3} at {4} Hz.' -f $w, $h, $m.w, $m.h, $m.f) }
          } else { $msg = ('Windows refused {0}x{1} (code {2}).' -f $m.w, $m.h, $rc) }
        }
      }
    }
  } catch { $msg = ('Screen change failed: {0}' -f $_.Exception.Message) }
  (@{ id = $req.id; ok = $ok; message = $msg } | ConvertTo-Json -Compress) | Set-Content $resultPath -Encoding UTF8
  exit 0
}

# ---------------------------------------------------------------------------
# The agent (SYSTEM, at boot)
# ---------------------------------------------------------------------------
$cfg = Get-Content (Join-Path $Dir 'agent.json') -Raw | ConvertFrom-Json
$Headers = @{ Authorization = ('Bearer ' + $cfg.token) }
$SunshineExe = Join-Path $env:ProgramFiles 'Sunshine\sunshine.exe'

function Post($path, $obj, $timeout) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 6 -Compress))
  return Invoke-RestMethod -Method Post -Uri ($cfg.api + '/local-agent/' + $path) -Headers $Headers -ContentType 'application/json' -Body $bytes -TimeoutSec $timeout
}

function Get-Status {
  $s = @{ agentVersion = $AgentVersion; host = $env:COMPUTERNAME }
  try {
    $c = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
    if ($c) { $s.lanIp = @($c.IPv4Address)[0].IPAddress; $s.mac = $c.NetAdapter.MacAddress; $s.link = ('{0}' -f $c.NetAdapter.LinkSpeed); $s.wired = ($c.NetAdapter.PhysicalMediaType -notmatch 'Native 802.11|Wireless') }
  } catch { }
  try {
    $os = Get-CimInstance Win32_OperatingSystem
    $s.os = $os.Caption
    $s.uptimeHours = [Math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
    $s.ramGb = [Math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    $s.ramFreeGb = [Math]::Round($os.FreePhysicalMemory / 1MB, 1)
    $s.cpuPercent = [int](Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
  } catch { }
  try {
    $q = & nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,encoder.stats.sessionCount,memory.used,memory.total,driver_version --format=csv,noheader,nounits 2>$null
    if ($q) {
      $p = ($q | Select-Object -First 1) -split ',\s*'
      $s.gpu = @{ name = $p[0]; util = [int]$p[1]; tempC = [int]$p[2]; encoders = [int]$p[3]; vramUsedMb = [int]$p[4]; vramTotalMb = [int]$p[5]; driver = $p[6] }
      $s.streaming = ([int]$p[3] -gt 0)
    }
  } catch { }
  try { $sv = Get-Service -Name 'SunshineService' -ErrorAction Stop; $s.sunshine = $sv.Status.ToString() } catch { $s.sunshine = 'NotInstalled' }
  return $s
}

function Report($id, $ok, $msg) {
  try { [void](Post 'result' @{ id = $id; ok = $ok; message = $msg } 20) } catch { Log ('could not report a result: ' + $_.Exception.Message) }
}

# Curl.exe (in every Windows 11) talks to Sunshine's self-signed HTTPS; the login goes in on stdin, not the command line.
function Sunshine-Api($method, $path, $bodyFile) {
  $conf = 'user = "{0}:{1}"' -f $cfg.sunshineUser, $cfg.sunshinePassword
  $args2 = @('-sk', '-m', '10', '-K', '-', '-X', $method, '-w', '|%{http_code}')
  if ($bodyFile) { $args2 += @('-H', 'Content-Type: application/json', '--data-binary', ('@' + $bodyFile)) }
  $args2 += ('https://localhost:47990' + $path)
  return ($conf | & curl.exe @args2)
}

function Do-Pin($pin, $name) {
  $deadline = (Get-Date).AddSeconds(150)
  $tmp = Join-Path $Dir 'pin.json'
  $last = 'Sunshine did not answer.'
  while ((Get-Date) -lt $deadline) {
    try {
      $pending = Sunshine-Api 'GET' '/api/pin' $null
      $body = @{ pin = $pin; name = $name }
      $parts = $pending -split '\|'
      if ($parts[-1] -eq '401') { return @($false, 'Sunshine rejected the login the agent saved. Re-run the install command to reset it.') }
      if ($parts[-1] -eq '200') {
        try {
          $j = $parts[0] | ConvertFrom-Json
          if ($j.pairings) {
            if (-not @($j.pairings).Count) { $last = 'No device is waiting to pair yet. Run the moonlight pair command now.'; Start-Sleep -Seconds 2; continue }
            $body.pairing_id = @($j.pairings)[-1].id
          }
        } catch { }
      }
      ($body | ConvertTo-Json -Compress) | Set-Content $tmp -Encoding ASCII
      $r = Sunshine-Api 'POST' '/api/pin' $tmp
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
      $rp = $r -split '\|'
      if ($rp[-1] -eq '200' -and $rp[0] -match '"status"\s*:\s*"?true"?') { return @($true, 'Sunshine accepted the PIN: Moonlight is paired with this PC.') }
      $last = 'No device is waiting to pair yet. Run the moonlight pair command now.'
    } catch { $last = 'Could not reach Sunshine: ' + $_.Exception.Message }
    Start-Sleep -Seconds 2
  }
  return @($false, ('Pairing timed out. ' + $last))
}

function Do-Display($c, $action) {
  New-Item -ItemType Directory -Force -Path $DispDir | Out-Null
  Remove-Item (Join-Path $DispDir 'result.json') -Force -ErrorAction SilentlyContinue
  $req = @{ id = $c.id; action = $action }
  if ($action -eq 'set') { $req.width = [int]$c.args.width; $req.height = [int]$c.args.height; $req.fps = [int]$c.args.fps }
  ($req | ConvertTo-Json -Compress) | Set-Content (Join-Path $DispDir 'request.json') -Encoding UTF8
  Start-ScheduledTask -TaskName 'GGGH Display' | Out-Null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $rp = Join-Path $DispDir 'result.json'
    if (Test-Path $rp) {
      try { $r = Get-Content $rp -Raw | ConvertFrom-Json; if ($r.id -eq $c.id) { return @([bool]$r.ok, [string]$r.message) } } catch { }
    }
  }
  return @($false, 'Nobody is signed in to Windows on the PC (or it is locked), so its screen could not be changed.')
}

function Do-Script($text) {
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($text))
  $o = Join-Path $Dir 'script.out'; $e = Join-Path $Dir 'script.err'
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $enc) -RedirectStandardOutput $o -RedirectStandardError $e -PassThru -WindowStyle Hidden
  if (-not $p.WaitForExit(60000)) { try { $p.Kill() } catch { }; return @($false, 'The script ran for over 60 seconds and was stopped.') }
  $out = (Get-Content $o -Raw -ErrorAction SilentlyContinue) + (Get-Content $e -Raw -ErrorAction SilentlyContinue)
  Remove-Item $o, $e -Force -ErrorAction SilentlyContinue
  if ($out.Length -gt 3500) { $out = $out.Substring(0, 3500) + ' …(cut)' }
  return @(($p.ExitCode -eq 0), ('Exit code {0}. {1}' -f $p.ExitCode, $out))
}

function Run-Command($c) {
  Log ('command ' + $c.kind)
  try {
    switch ($c.kind) {
      'refresh' { Report $c.id $true 'Status refreshed.' }
      'sunshine-restart' { Restart-Service -Name 'SunshineService' -Force; Report $c.id $true 'Sunshine restarted.' }
      'sunshine-pin' { $r = Do-Pin ([string]$c.args.pin) ([string]$c.args.name); Report $c.id $r[0] $r[1] }
      'display-set' { $r = Do-Display $c 'set'; Report $c.id $r[0] $r[1] }
      'display-restore' { $r = Do-Display $c 'restore'; Report $c.id $r[0] $r[1] }
      'script' { $r = Do-Script ([string]$c.args.script); Report $c.id $r[0] $r[1] }
      'sleep' { Report $c.id $true 'Going to sleep.'; Start-Sleep -Seconds 2; Start-Process -FilePath 'rundll32.exe' -ArgumentList 'powrprof.dll,SetSuspendState 0,1,0' }
      'restart' { Report $c.id $true 'Restarting.'; & shutdown.exe /r /t 5 /c 'Restart requested from GGGH' }
      'shutdown' { Report $c.id $true 'Shutting down.'; & shutdown.exe /s /t 5 /c 'Shutdown requested from GGGH' }
      default { Report $c.id $false ('Unknown command: ' + $c.kind) }
    }
  } catch { Report $c.id $false ('Failed: ' + $_.Exception.Message) }
}

Log ('agent ' + $AgentVersion + ' starting')
$fails = 0
while ($true) {
  $t0 = Get-Date
  try {
    $r = Post 'poll' (Get-Status) 45
    $fails = 0
    foreach ($c in @($r.commands)) { Run-Command $c }
    if (((Get-Date) - $t0).TotalSeconds -lt 1.5) { Start-Sleep -Seconds 2 }
  } catch {
    $fails++
    $code = 0; try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    Log ('poll failed ({0}): {1}' -f $code, $_.Exception.Message)
    if ($code -eq 401) { Start-Sleep -Seconds 60 } else { Start-Sleep -Seconds ([Math]::Min(60, 3 * $fails)) }
  }
}
`;

export const INSTALL_PS1 = String.raw`# GGGH local machine installer. Run in an ELEVATED PowerShell (Run as administrator).
param([Parameter(Mandatory = $true)][string]$Token, [Parameter(Mandatory = $true)][string]$Api)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Please run this in an elevated PowerShell: right-click Start, then "Terminal (Admin)".' -ForegroundColor Yellow; return }
if ($Token -notmatch '^cgl_[A-Za-z0-9_-]{20,}$') { Write-Host 'That token does not look right. Copy the whole command from GGGH.' -ForegroundColor Yellow; return }

$Dir = Join-Path $env:ProgramData 'GGGH'
$DispDir = Join-Path $Dir 'display'
New-Item -ItemType Directory -Force -Path $Dir, $DispDir | Out-Null
# The screen helper runs as the signed-in user and writes its answer here.
& icacls.exe $DispDir /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null

Write-Host '1/5 Downloading the GGGH agent...'
Invoke-WebRequest -UseBasicParsing -Uri ($Api + '/local-agent/agent.ps1') -OutFile (Join-Path $Dir 'gggh-agent.ps1')

$SunshineDir = Join-Path $env:ProgramFiles 'Sunshine'
$SunshineExe = Join-Path $SunshineDir 'sunshine.exe'
if (-not (Test-Path $SunshineExe)) {
  Write-Host '2/5 Installing Sunshine (this takes a minute)...'
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Write-Host 'winget was not found. Install "App Installer" from the Microsoft Store, or install Sunshine from github.com/LizardByte/Sunshine/releases, then run this command again.' -ForegroundColor Yellow; return }
  & winget install --id LizardByte.Sunshine -e --silent --accept-package-agreements --accept-source-agreements
  if (-not (Test-Path $SunshineExe)) { Write-Host 'Sunshine did not install. Try installing it by hand (github.com/LizardByte/Sunshine/releases), then run this command again.' -ForegroundColor Yellow; return }
} else { Write-Host '2/5 Sunshine is already installed.' }

Write-Host '3/5 Setting Sunshine login (only this PC knows it)...'
$cfgPath = Join-Path $Dir 'agent.json'
$user = 'gggh'
$pass = $null
$existing = $null
if (Test-Path $cfgPath) { try { $existing = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch { } }
if ($existing -and $existing.sunshinePassword) { $user = $existing.sunshineUser; $pass = $existing.sunshinePassword }
else {
  $bytes = New-Object byte[] 18; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $pass = [Convert]::ToBase64String($bytes).Replace('+', 'x').Replace('/', 'y').Replace('=', '')
  & $SunshineExe --creds $user $pass | Out-Null
}
$json = @{ api = $Api; token = $Token; sunshineUser = $user; sunshinePassword = $pass } | ConvertTo-Json -Compress
Set-Content -Path $cfgPath -Value $json -Encoding ASCII
& icacls.exe $cfgPath /inheritance:r /grant 'SYSTEM:F' 'Administrators:F' | Out-Null
try { Restart-Service -Name 'SunshineService' -Force } catch { Write-Host 'Could not restart Sunshine now; it will use the login after a restart.' -ForegroundColor Yellow }

Write-Host '4/5 Turning on Wake-on-LAN where the network card allows it...'
try {
  Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
    try { Set-NetAdapterPowerManagement -Name $_.Name -WakeOnMagicPacket Enabled -ErrorAction Stop } catch { Write-Host ('  {0}: not switched on ({1})' -f $_.Name, 'check the BIOS and the adapter power settings') -ForegroundColor Yellow }
  }
} catch { }

Write-Host '5/5 Starting the agent...'
$agentPath = Join-Path $Dir 'gggh-agent.ps1'
$arg = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $agentPath
$set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$agentTask = @{
  TaskName = 'GGGH Agent'; Force = $true; Settings = $set
  Action = (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg)
  Trigger = (New-ScheduledTaskTrigger -AtStartup)
  Principal = (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest)
}
Register-ScheduledTask @agentTask | Out-Null
$dset = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$displayTask = @{
  TaskName = 'GGGH Display'; Force = $true; Settings = $dset
  Action = (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ($arg + ' -Mode display'))
  Principal = (New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited)
}
Register-ScheduledTask @displayTask | Out-Null
Stop-ScheduledTask -TaskName 'GGGH Agent' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'GGGH Agent'

Write-Host ''
Write-Host 'Done. Go back to GGGH: this PC should show as online within a few seconds.' -ForegroundColor Green
Write-Host ('Sunshine admin page (on this PC): https://localhost:47990 (user name: {0}; the password is saved in the agent file)' -f $user)
Write-Host 'For waking this PC from sleep, use a wired network connection.'
`;
