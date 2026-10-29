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
 *              Since version 2 it also: diagnoses (settings, network, GPU, Sunshine log, Windows
 *              errors), records per-second samples while you stream (sent live), fetches logs, and
 *              runs a short list of reversible tuning actions (power plan, GPU clock lock, a few
 *              Sunshine settings with a backup). It updates ITSELF: GGGH tells it when the copy it
 *              serves differs (by SHA-256); the agent downloads it, checks the hash and that it
 *              parses, keeps the old one as .bak, and exits so BOOT_PS1 starts the new one.
 *
 * BOOT_PS1     the tiny wrapper the "GGGH Agent" task really runs: restarts the agent when it
 *              stops and, if a freshly updated agent crashes 3 times in a row, puts the previous
 *              one back. It can be updated the same way.
 *
 * Windows PowerShell 5.1 compatible (the one every Windows 11 has). ASCII ONLY (5.1 reads a
 * download without a byte-order mark as ANSI, which would garble anything else). No backticks
 * or "${" anywhere (String.raw template).
 */

import crypto from 'crypto';


export const AGENT_PS1 = String.raw`# GGGH agent for a local Windows PC. Connects out to GGGH; opens nothing.
param([string]$Mode = 'service', [string]$Sid = '', [int]$Port = 22, [string]$TargetHost = '127.0.0.1')
$ErrorActionPreference = 'Stop'
$AgentVersion = '15'
$Dir = Join-Path $env:ProgramData 'GGGH'
$DispDir = Join-Path $Dir 'display'
$Log = Join-Path $Dir 'agent.log'
$AgentFile = Join-Path $Dir 'gggh-agent.ps1'
$BootFile = Join-Path $Dir 'gggh-boot.ps1'
$VirtRe = 'Virtual|MttVDD|IddSample|IDD|Indirect|Parsec'   # how a virtual display shows up in Windows
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Log($m) {
  try {
    Add-Content -Path $Log -Value ('{0} {1}' -f (Get-Date -Format 's'), $m)
    if ((Get-Item $Log).Length -gt 400KB) { Move-Item $Log ($Log + '.old') -Force }
  } catch { }
}

# ---------------------------------------------------------------------------
# One SSH connection through GGGH (runs as its own small process: -Mode tunnel).
# Dials out to GGGH over a WebSocket and joins it to this PC's own SSH server.
# ---------------------------------------------------------------------------
if ($Mode -eq 'tunnel') {
  Log ('ssh tunnel ' + $Sid.Substring(0, 8) + ' starting')
  try {
  Add-Type -ReferencedAssemblies 'System.dll' -TypeDefinition @'
using System;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;
public static class GgghTunnel {
  public static string Err = "";
  public static string Stage = "start";
  public static int Run(string url, string bearer, string host, int port) {
    ClientWebSocket ws = new ClientWebSocket();
    TcpClient tcp = new TcpClient();
    try {
      ws.Options.SetRequestHeader("Authorization", "Bearer " + bearer);
      ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
      Stage = "opening the connection to GGGH";
      if (!ws.ConnectAsync(new Uri(url), CancellationToken.None).Wait(15000)) { Err = "could not open the connection to GGGH"; return 2; }
      Stage = "connecting to the SSH server";
      tcp.Connect(host, port);
      Stage = "relaying";
      NetworkStream ns = tcp.GetStream();
      Task up = Task.Run(() => {
        byte[] buf = new byte[16384];
        while (ws.State == WebSocketState.Open) {
          WebSocketReceiveResult r = ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None).Result;
          if (r.MessageType == WebSocketMessageType.Close) break;
          ns.Write(buf, 0, r.Count);
        }
      });
      Task down = Task.Run(() => {
        byte[] buf = new byte[16384];
        int n;
        while ((n = ns.Read(buf, 0, buf.Length)) > 0) {
          ws.SendAsync(new ArraySegment<byte>(buf, 0, n), WebSocketMessageType.Binary, true, CancellationToken.None).Wait();
        }
      });
      Task.WaitAny(up, down);
      return 0;
    } catch (Exception ex) {
      Err = Stage + ": " + ex.GetBaseException().Message;
      return 3;
    } finally {
      try { tcp.Close(); } catch (Exception) { }
      try { ws.Abort(); } catch (Exception) { }
    }
  }
}
'@
  $cfg0 = Get-Content (Join-Path $Dir 'agent.json') -Raw | ConvertFrom-Json
  $wsUrl = ($cfg0.api -replace '^http', 'ws') + '/local-agent/tunnel/' + $Sid
  $rc = [GgghTunnel]::Run($wsUrl, [string]$cfg0.token, $TargetHost, $Port)
  Log ('ssh tunnel ' + $Sid.Substring(0, 8) + ' to ' + $TargetHost + ':' + $Port + ' ended (code ' + $rc + ') ' + [GgghTunnel]::Err)
  } catch { Log ('ssh tunnel ' + $Sid.Substring(0, 8) + ' FAILED: ' + $_.Exception.Message) }
  exit 0
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
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
public struct DispDev {
  public int cb;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
  public int StateFlags;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
}
public static class Disp {
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DispMode dm);
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern int ChangeDisplaySettingsEx(string dev, ref DispMode dm, IntPtr hwnd, int flags, IntPtr lp);
  [DllImport("user32.dll", CharSet = CharSet.Ansi, EntryPoint = "ChangeDisplaySettingsExA")] public static extern int Commit(string dev, IntPtr dm, IntPtr hwnd, int flags, IntPtr lp);
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern bool EnumDisplayDevices(string dev, int i, ref DispDev dd, int flags);
}
'@
  function New-Mode { $dm = New-Object DispMode; $dm.dmSize = [int16][Runtime.InteropServices.Marshal]::SizeOf([type]'DispMode'); return $dm }
  function Get-Current { $dm = New-Mode; [void][Disp]::EnumDisplaySettings($null, -1, [ref]$dm); return $dm }
  function Get-Modes($dev) {
    $list = @(); $i = 0
    while ($true) {
      $dm = New-Mode
      if (-not [Disp]::EnumDisplaySettings($dev, $i, [ref]$dm)) { break }
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

  # Every display Windows knows of: the real monitors and any virtual one.
  function Get-Screens {
    $list = @(); $i = 0
    while ($true) {
      $dd = New-Object DispDev
      $dd.cb = [Runtime.InteropServices.Marshal]::SizeOf([type]'DispDev')
      if (-not [Disp]::EnumDisplayDevices($null, $i, [ref]$dd, 0)) { break }
      $i++
      if (($dd.StateFlags -band 8) -ne 0) { continue }
      $dm = New-Mode
      [void][Disp]::EnumDisplaySettings($dd.DeviceName, -1, [ref]$dm)
      $list += [pscustomobject]@{
        name = $dd.DeviceName; desc = $dd.DeviceString; devid = $dd.DeviceID
        attached = (($dd.StateFlags -band 1) -ne 0); primary = (($dd.StateFlags -band 4) -ne 0)
        x = $dm.dmPositionX; y = $dm.dmPositionY; w = $dm.dmPelsWidth; h = $dm.dmPelsHeight; f = $dm.dmDisplayFrequency
      }
    }
    return $list
  }
  # Place one display (or, with w = h = 0, take it off the desktop). Takes effect at Commit.
  function Set-Dev($name, $x, $y, $w, $h, $f, $extra) {
    $dm = New-Mode
    [void][Disp]::EnumDisplaySettings($name, -1, [ref]$dm)
    $dm.dmPositionX = $x; $dm.dmPositionY = $y; $dm.dmPelsWidth = $w; $dm.dmPelsHeight = $h
    $fields = 0x20 -bor 0x80000 -bor 0x100000
    if ($w -gt 0) { $dm.dmBitsPerPel = 32; $fields = $fields -bor 0x40000 }
    if ($f -gt 0) { $dm.dmDisplayFrequency = $f; $fields = $fields -bor 0x400000 }
    $dm.dmFields = $fields
    return [Disp]::ChangeDisplaySettingsEx($name, [ref]$dm, [IntPtr]::Zero, (0x1 -bor 0x10000000 -bor $extra), [IntPtr]::Zero)
  }
  function Commit-Screens { return [Disp]::Commit($null, [IntPtr]::Zero, [IntPtr]::Zero, 0, [IntPtr]::Zero) }

  $topoPath = Join-Path $DispDir 'topology.json'
  # Headless: the virtual display becomes the only screen, at the receiver's size.
  function Do-Headless($w, $h, $fps) {
    $screens = @(Get-Screens)
    $v = $screens | Where-Object { $_.desc -match $VirtRe -or $_.devid -match 'ROOT.DISPLAY|MttVDD' } | Select-Object -First 1
    if (-not $v) { return @($false, 'This PC has no virtual display yet. Install one from GGGH (Settings, "Virtual display"), then try again.') }
    $others = @($screens | Where-Object { $_.name -ne $v.name -and $_.attached })
    if (-not (Test-Path $topoPath)) {
      $keep = @($screens | Where-Object { $_.attached } | ForEach-Object { @{ name = $_.name; x = $_.x; y = $_.y; w = $_.w; h = $_.h; f = $_.f; primary = $_.primary } })
      (@{ screens = $keep; virtualName = $v.name; virtualWasAttached = [bool]$v.attached } | ConvertTo-Json -Depth 4 -Compress) | Set-Content $topoPath -Encoding ASCII
    }
    $pick = Pick (Get-Modes $v.name) $w $h $fps
    if (-not $pick) { return @($false, ('The virtual display offers no {0}x{1} mode, or one of the same shape. Add it to the virtual display driver''s resolution list, then try again.' -f $w, $h)) }
    $m = $pick.mode
    $rc = Set-Dev $v.name 0 0 $m.w $m.h $m.f 0x10
    if ($rc -ne 0) { [void](Do-RestoreTopology); return @($false, ('Windows would not use the virtual display at {0}x{1} (code {2}); the screens were left as they were.' -f $m.w, $m.h, $rc)) }
    foreach ($p in $others) { [void](Set-Dev $p.name 0 0 0 0 0 0) }
    $rc = Commit-Screens
    if ($rc -ne 0) { [void](Do-RestoreTopology); return @($false, ('Windows refused the screen change (code {0}); the screens were put back.' -f $rc)) }
    $after = @(Get-Screens | Where-Object { $_.name -eq $v.name -and $_.attached })
    if (-not $after.Count) { [void](Do-RestoreTopology); return @($false, 'The virtual display did not switch on; the screens were put back.') }
    if ($pick.exact) { return @($true, ('Headless: the PC''s own screens are off and the virtual display is {0}x{1} at {2} Hz.' -f $m.w, $m.h, $m.f)) }
    return @($true, ('Headless, but no exact {0}x{1}: the virtual display uses {2}x{3} at {4} Hz.' -f $w, $h, $m.w, $m.h, $m.f))
  }
  # Put the real screens back exactly where they were. $null = nothing to put back.
  function Do-RestoreTopology {
    if (-not (Test-Path $topoPath)) { return $null }
    $t = Get-Content $topoPath -Raw | ConvertFrom-Json
    $saved = @($t.screens)
    $order = @($saved | Where-Object { $_.primary }) + @($saved | Where-Object { -not $_.primary })
    foreach ($s in $order) { $x = $(if ($s.primary) { 0x10 } else { 0 }); [void](Set-Dev $s.name ([int]$s.x) ([int]$s.y) ([int]$s.w) ([int]$s.h) ([int]$s.f) $x) }
    if (-not $t.virtualWasAttached) { [void](Set-Dev $t.virtualName 0 0 0 0 0 0) }
    $rc = Commit-Screens
    if ($rc -eq 0) { Remove-Item $topoPath -Force; return @($true, 'The PC''s own screens are back on.') }
    return @($false, ('Windows refused to put the screens back (code {0}).' -f $rc))
  }

  $resultPath = Join-Path $DispDir 'result.json'
  $req = Get-Content (Join-Path $DispDir 'request.json') -Raw | ConvertFrom-Json
  $ok = $false; $msg = ''
  try {
    $orig = Join-Path $DispDir 'original.json'
    if ($req.action -eq 'restore') {
      $parts = @(); $ok = $true
      $tr = Do-RestoreTopology
      if ($tr) { $parts += $tr[1]; if (-not $tr[0]) { $ok = $false } }
      if (Test-Path $orig) {
        $o = Get-Content $orig -Raw | ConvertFrom-Json
        $rc = Apply-Mode ([int]$o.w) ([int]$o.h) ([int]$o.f)
        if ($rc -eq 0) { Remove-Item $orig -Force; $parts += ('Screen put back to {0}x{1} at {2} Hz.' -f $o.w, $o.h, $o.f) } else { $ok = $false; $parts += ('Windows refused to put the screen back (code {0}).' -f $rc) }
      }
      if (-not $parts.Count) { $parts += 'The screen was already as you left it.' }
      $msg = $parts -join ' '
    } elseif ($req.action -eq 'headless') {
      $r = Do-Headless ([int]$req.width) ([int]$req.height) ([int]$req.fps)
      $ok = [bool]$r[0]; $msg = [string]$r[1]
    } else {
      $w = [int]$req.width; $h = [int]$req.height; $fps = [int]$req.fps
      $cur = Get-Current
      if ($cur.dmPelsWidth -eq $w -and $cur.dmPelsHeight -eq $h) { $ok = $true; $msg = ('The screen is already {0}x{1}.' -f $w, $h) }
      else {
        $pick = Pick (Get-Modes $null) $w $h $fps
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
# The agent (SYSTEM, at boot, started by gggh-boot.ps1)
# ---------------------------------------------------------------------------
$cfg = Get-Content (Join-Path $Dir 'agent.json') -Raw | ConvertFrom-Json
$Headers = @{ Authorization = ('Bearer ' + $cfg.token) }
$SunshineDir = Join-Path $env:ProgramFiles 'Sunshine'
$SunshineExe = Join-Path $SunshineDir 'sunshine.exe'
$SunshineConf = Join-Path $SunshineDir 'config\sunshine.conf'
$SunshineLog = Join-Path $SunshineDir 'config\sunshine.log'
$HighPerf = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
$script:lastBeat = Get-Date

function Post($path, $obj, $timeout) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 9 -Compress))
  return Invoke-RestMethod -Method Post -Uri ($cfg.api + '/local-agent/' + $path) -Headers $Headers -ContentType 'application/json' -Body $bytes -TimeoutSec $timeout
}

# "Still here", from inside long jobs, so the PC does not show as offline meanwhile.
function Beat {
  if (((Get-Date) - $script:lastBeat).TotalSeconds -ge 15) {
    $script:lastBeat = Get-Date
    try { [void](Post 'heartbeat' @{} 10) } catch { }
  }
}

function Hash-Of($path) { try { return (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower() } catch { return '' } }

function N($v) {
  $d = 0.0
  if ([double]::TryParse([string]$v, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$d)) { return $d }
  return $null
}

# One nvidia-smi query; the values in the order asked, or $null when the driver rejects a field.
function Smi($fields) {
  try {
    $o = & nvidia-smi ('--query-gpu=' + $fields) --format=csv,noheader,nounits 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $o) { return $null }
    return @((($o | Select-Object -First 1) -split ',\s*'))
  } catch { return $null }
}

# Encoder / decoder load in percent (nvidia-smi dmon prints: gpu sm mem enc dec ...). Takes about a second.
function Smi-Enc {
  try {
    $o = & nvidia-smi dmon -c 1 -s u 2>$null
    $line = @($o | Where-Object { $_ -and $_.Trim() -notmatch '^#' }) | Select-Object -Last 1
    if (-not $line) { return $null }
    $t = @($line.Trim() -split '\s+')
    if ($t.Count -ge 5) { return @{ enc = (N $t[3]); dec = (N $t[4]) } }
  } catch { }
  return $null
}

function Get-NetInfo {
  $r = @{}
  try {
    $c = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
    if ($c) {
      $r.name = $c.InterfaceAlias
      $r.lanIp = @($c.IPv4Address)[0].IPAddress
      $r.gateway = @($c.IPv4DefaultGateway)[0].NextHop
      $r.mac = $c.NetAdapter.MacAddress
      $r.linkMbps = [int]($c.NetAdapter.Speed / 1000000)
      $r.wired = ($c.NetAdapter.PhysicalMediaType -notmatch 'Native 802.11|Wireless')
      $r.desc = $c.NetAdapter.InterfaceDescription
    }
  } catch { }
  return $r
}

function Ping-Gateway($gw, $count) {
  $res = @{ sent = $count; lost = 0; avgMs = 0; maxMs = 0 }
  if (-not $gw) { $res.sent = 0; return $res }
  $p = New-Object Net.NetworkInformation.Ping
  $times = @()
  for ($i = 0; $i -lt $count; $i++) {
    try { $r = $p.Send($gw, 1000); if ($r.Status -eq 'Success') { $times += [int]$r.RoundtripTime } else { $res.lost++ } } catch { $res.lost++ }
    Start-Sleep -Milliseconds 150
  }
  if ($times.Count) { $res.avgMs = [Math]::Round(($times | Measure-Object -Average).Average, 1); $res.maxMs = ($times | Measure-Object -Maximum).Maximum }
  return $res
}

# Slower readings, taken at most every 20 seconds: busiest core, disk latency, GPU programs, ping to the
# streaming device, what Sunshine is streaming, PCIe link. Every part is optional; a failure just leaves it out.
function Last-Match($lines, $pattern) {
  $m = $null
  foreach ($l in $lines) { if ($l -match $pattern) { $m = $Matches[1] } }
  return $m
}

function Get-Extras($streaming) {
  $x = @{}
  try {
    $cores = @(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -ErrorAction Stop | Where-Object { $_.Name -ne '_Total' })
    if ($cores.Count) { $x.cores = $cores.Count; $x.topCore = [int](($cores | Measure-Object -Property PercentProcessorTime -Maximum).Maximum) }
  } catch { }
  try {
    $cs = (Get-Counter -Counter '\PhysicalDisk(_Total)\Avg. Disk sec/Read', '\PhysicalDisk(_Total)\Avg. Disk sec/Write', '\PhysicalDisk(_Total)\Current Disk Queue Length' -ErrorAction Stop).CounterSamples
    if (@($cs).Count -ge 3) { $x.diskLat = @([Math]::Round($cs[0].CookedValue * 1000, 1), [Math]::Round($cs[1].CookedValue * 1000, 1), [int]$cs[2].CookedValue) }
  } catch { }
  try {
    $mem = @{}; $eng = @{}
    foreach ($m in @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction Stop)) {
      if ($m.Name -match '^pid_(\d+)_') { $k = $Matches[1]; if (-not $mem.ContainsKey($k)) { $mem[$k] = 0.0 }; $mem[$k] += [double]$m.DedicatedUsage }
    }
    foreach ($e in @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop)) {
      if ($e.Name -match '^pid_(\d+)_') { $k = $Matches[1]; if (-not $eng.ContainsKey($k) -or $eng[$k] -lt [double]$e.UtilizationPercentage) { $eng[$k] = [double]$e.UtilizationPercentage } }
    }
    $rows = @()
    foreach ($k in @($mem.Keys)) {
      $nm = '?'; try { $nm = (Get-Process -Id ([int]$k) -ErrorAction Stop).ProcessName } catch { }
      $pc = $null; if ($eng.ContainsKey($k)) { $pc = [Math]::Round($eng[$k], 0) }
      $rows += ,@($nm, [int]($mem[$k] / 1MB), $pc)
    }
    if ($rows.Count) { $x.gpuProcs = @($rows | Sort-Object { -$_[1] } | Select-Object -First 4) }
  } catch { }
  try {
    $q = Smi 'pcie.link.gen.current,pcie.link.gen.max,pcie.link.width.current,pcie.link.width.max'
    if ($q -and $q.Count -ge 4) { $x.pcie = @{ lg = (N $q[0]); lx = (N $q[1]); lw = (N $q[2]); lm = (N $q[3]) } }
    $f = Smi 'fan.speed'; if ($f) { $fv = N $f[0]; if ($null -ne $fv) { $x.fan = $fv } }
  } catch { }
  try {
    $lines = @(Tail-Lines $SunshineLog 600 120000)
    $b = Last-Match $lines 'Streaming bitrate is (\d+)'
    $st = @{}
    if ($b) { $st.b = [Math]::Round([double]$b / 1e6, 1) }
    $en = Last-Match $lines 'Creating encoder \[([A-Za-z0-9_]+)\]'; if ($en) { $st.e = $en }
    $cd = Last-Match $lines 'Color depth: (\d+)-bit'; if ($cd) { $st.d = $cd }
    $rs = Last-Match $lines '(\d{3,5}x\d{3,5})'; if ($rs) { $st.r = $rs }
    $fr = Last-Match $lines '(?:[Ff]rame ?rate|fps)[^0-9]{0,12}(\d{2,3})'; if ($fr) { $st.f = [int]$fr }
    if ($st.Count) { $x.stream = $st }
  } catch { }
  # The streaming device: seen on Sunshine's ports; ping it a few times while somebody is streaming.
  try {
    $c = @(Get-NetTCPConnection -LocalPort 47984, 47989, 48010 -ErrorAction Stop | Where-Object { $_.RemoteAddress -match '^\d{1,3}(\.\d{1,3}){3}$' -and $_.RemoteAddress -notmatch '^(127\.|0\.)' } | Select-Object -First 1)
    if ($c.Count) { $script:clientIp = $c[0].RemoteAddress }
    if (-not $streaming) { $script:clientIp = $null }
    if ($script:clientIp) {
      $p = New-Object Net.NetworkInformation.Ping; $t = @(); $lost = 0
      for ($i = 0; $i -lt 4; $i++) {
        try { $r = $p.Send($script:clientIp, 800); if ($r.Status -eq 'Success') { $t += [double]$r.RoundtripTime } else { $lost++ } } catch { $lost++ }
        Start-Sleep -Milliseconds 150
      }
      if ($t.Count) {
        $avg = ($t | Measure-Object -Average).Average
        $x.rtt = @{ r = [Math]::Round($avg, 1); j = [Math]::Round((($t | ForEach-Object { [Math]::Abs($_ - $avg) } | Measure-Object -Average).Average), 1); l = [Math]::Round(100 * $lost / 4, 0) }
      } else { $x.rtt = @{ o = 1 } }
    }
  } catch { }
  return $x
}

function Get-Status {
  $s = @{ agentVersion = $AgentVersion; host = $env:COMPUTERNAME; canUpdate = $true; agentSha = (Hash-Of $AgentFile); bootSha = (Hash-Of $BootFile) }
  try {
    $n = Get-NetInfo
    if ($n.lanIp) { $s.lanIp = $n.lanIp; $s.mac = $n.mac; $s.wired = $n.wired; $s.link = ('{0} Mbit/s' -f $n.linkMbps) }
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
    $q = & nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,encoder.stats.sessionCount,memory.used,memory.total,driver_version,power.draw,power.limit --format=csv,noheader,nounits 2>$null
    if ($q) {
      $p = @(($q | Select-Object -First 1) -split ',\s*')
      $s.gpu = @{ name = $p[0]; util = [int]$p[1]; tempC = [int]$p[2]; encoders = [int]$p[3]; vramUsedMb = [int]$p[4]; vramTotalMb = [int]$p[5]; driver = $p[6]; powerW = (N $p[7]); powerLimitW = (N $p[8]) }
      $s.streaming = ([int]$p[3] -gt 0)
    }
  } catch { }
  # Network rate since the last status (physical adapters that are up), and the system drive.
  try {
    $ad = @(Get-NetAdapter -Physical -ErrorAction Stop | Where-Object { $_.Status -eq 'Up' } | Get-NetAdapterStatistics -ErrorAction Stop)
    $tx = [double]($ad | Measure-Object -Property SentBytes -Sum).Sum; $rx = [double]($ad | Measure-Object -Property ReceivedBytes -Sum).Sum
    $now = Get-Date
    if ($script:netAt -and ($now - $script:netAt).TotalSeconds -ge 5) {
      $secs = ($now - $script:netAt).TotalSeconds
      if ($tx -ge $script:netTx) { $s.txMbps = [Math]::Round((($tx - $script:netTx) * 8 / 1e6) / $secs, 2) }
      if ($rx -ge $script:netRx) { $s.rxMbps = [Math]::Round((($rx - $script:netRx) * 8 / 1e6) / $secs, 2) }
    }
    $s.txGb = [Math]::Round($tx / 1GB, 3)
    $er = [double](($ad | Measure-Object -Property OutboundPacketErrors, ReceivedPacketErrors -Sum | Measure-Object -Property Sum -Sum).Sum)
    $dr2 = [double](($ad | Measure-Object -Property OutboundDiscardedPackets, ReceivedDiscardedPackets -Sum | Measure-Object -Property Sum -Sum).Sum)
    if ($null -ne $script:netErrPrev -and $er -ge $script:netErrPrev -and $dr2 -ge $script:netDropPrev) { $s.netErr = @([int]($er - $script:netErrPrev), [int]($dr2 - $script:netDropPrev), 0) }
    $script:netErrPrev = $er; $script:netDropPrev = $dr2
    if (-not $script:netAt -or ($now - $script:netAt).TotalSeconds -ge 5) { $script:netAt = $now; $script:netTx = $tx; $script:netRx = $rx }
  } catch { }
  try { $dr = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':')) -ErrorAction Stop; $s.diskUsedGb = [Math]::Round($dr.Used / 1GB, 0); $s.diskTotalGb = [Math]::Round(($dr.Used + $dr.Free) / 1GB, 0) } catch { }
  $s.ssh = Get-SshInfo
  # The internet address this PC's connection shows to the world (asked of an outside service, every 10 minutes).
  if (-not $script:ipAt -or ((Get-Date) - $script:ipAt).TotalMinutes -ge 10) {
    try { $script:myIp = ([string](Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 5)).Trim() } catch { }
    $script:ipAt = Get-Date
  }
  if ($script:myIp -match '^\d{1,3}(\.\d{1,3}){3}$') { $s.myIp = $script:myIp }
  try {
    $s.away = @{ upnp = ''; webUi = ''; profile = '' }
    if (Test-Path $SunshineConf) {
      foreach ($l in @(Get-Content $SunshineConf -ErrorAction SilentlyContinue)) {
        if ($l -match '^\s*upnp\s*=\s*(\S+)') { $s.away.upnp = $Matches[1] }
        if ($l -match '^\s*origin_web_ui_allowed\s*=\s*(\S+)') { $s.away.webUi = $Matches[1] }
      }
    }
    $np = @(Get-NetConnectionProfile -ErrorAction Stop | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' } | Select-Object -First 1)
    if ($np.Count) { $s.away.profile = [string]$np[0].NetworkCategory }
  } catch { }
  $vi = Get-VirtualInfo
  $s.display = @{ mode = $(if (Test-Path $HeadlessFile) { 'headless' } else { 'mirror' }); virtual = [bool]$vi.virtual; virtualState = [string]$vi.state; seen = @($vi.seen) }
  try { $sv = Get-Service -Name 'SunshineService' -ErrorAction Stop; $s.sunshine = $sv.Status.ToString() } catch { $s.sunshine = 'NotInstalled' }
  try {
    if (-not $script:extrasAt -or ((Get-Date) - $script:extrasAt).TotalSeconds -ge 20) {
      $script:extras = Get-Extras ($s.streaming -eq $true)
      $script:extrasAt = Get-Date
    }
    foreach ($k in @($script:extras.Keys)) { $s[$k] = $script:extras[$k] }
  } catch { }
  return $s
}

function Report($id, $ok, $msg) {
  try { [void](Post 'result' @{ id = $id; ok = $ok; message = $msg } 20) } catch { Log ('could not report a result: ' + $_.Exception.Message) }
}

function Send-Report($commandId, $kind, $data) {
  $r = Post 'report' @{ commandId = $commandId; kind = $kind; data = $data } 60
  return $r.id
}

# Never send anything that looks like a secret.
function Scrub($line) {
  if ([string]$line -match '(?i)(password|passwd|secret|token|authorization|cookie|api[_-]?key)') { return '[line hidden: looks like a secret]' }
  return [string]$line
}

function Tail-Lines($path, $n, $maxChars) {
  if (-not (Test-Path $path)) { return @() }
  $lines = @(Get-Content -Path $path -Tail $n -ErrorAction SilentlyContinue | ForEach-Object { Scrub $_ })
  $total = 0; $keep = New-Object System.Collections.ArrayList
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $total += $lines[$i].Length + 1
    if ($total -gt $maxChars) { break }
    [void]$keep.Insert(0, $lines[$i])
  }
  return @($keep)
}

# ---------------------------------------------------------------------------
# Diagnose: one snapshot of everything that matters for streaming
# ---------------------------------------------------------------------------
function Do-Diagnose($c) {
  $d = @{ at = (Get-Date).ToUniversalTime().ToString('s') + 'Z'; agentVersion = $AgentVersion }
  try { $os = Get-CimInstance Win32_OperatingSystem; $d.os = @{ caption = $os.Caption; build = $os.BuildNumber; uptimeHours = [Math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1) }; $d.ram = @{ totalGb = [Math]::Round($os.TotalVisibleMemorySize / 1MB, 1); freeGb = [Math]::Round($os.FreePhysicalMemory / 1MB, 1) } } catch { }
  try { $cp = Get-CimInstance Win32_Processor | Select-Object -First 1; $d.cpu = @{ name = $cp.Name.Trim(); cores = $cp.NumberOfCores; threads = $cp.NumberOfLogicalProcessors; percent = [int]$cp.LoadPercentage } } catch { }
  try {
    $line = (& powercfg /getactivescheme) | Out-String
    $guid = ''; if ($line -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') { $guid = $Matches[1].ToLower() }
    $nm = ''; if ($line -match '\(([^)]+)\)') { $nm = $Matches[1] }
    $d.power = @{ active = $nm; guid = $guid }
  } catch { }
  try { $d.hags = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' -Name HwSchMode -ErrorAction Stop).HwSchMode } catch { }
  # Network
  $n = Get-NetInfo
  if ($n.name) {
    $nic = @{ name = $n.name; desc = $n.desc; linkMbps = $n.linkMbps; wired = $n.wired }
    try { $st = Get-NetAdapterStatistics -Name $n.name; $nic.stats = @{ rxDiscard = [int64]$st.ReceivedDiscardedPackets; rxErr = [int64]$st.ReceivedPacketErrors; txDiscard = [int64]$st.OutboundDiscardedPackets; txErr = [int64]$st.OutboundPacketErrors } } catch { }
    try { $nic.adv = @(Get-NetAdapterAdvancedProperty -Name $n.name -ErrorAction Stop | Where-Object { $_.DisplayName -match 'Energy|Green|Interrupt|Flow|Speed|Jumbo|Wake' } | ForEach-Object { @{ n = $_.DisplayName; v = [string]$_.DisplayValue } }) } catch { }
    $d.nic = $nic
    $d.gateway = Ping-Gateway $n.gateway 12
  }
  # GPU
  $f = 'name,driver_version,pstate,clocks.sm,clocks.max.sm,clocks.mem,clocks.max.mem,power.draw,power.limit,temperature.gpu,utilization.gpu,utilization.memory,pcie.link.gen.current,pcie.link.width.current,memory.used,memory.total,encoder.stats.sessionCount,encoder.stats.averageFps,encoder.stats.averageLatency'
  $p = Smi ($f + ',clocks_throttle_reasons.active')
  $hasThrottle = $true
  if (-not $p) { $p = Smi $f; $hasThrottle = $false }
  if ($p) {
    $d.gpu = @{ name = $p[0]; driver = $p[1]; pstate = $p[2]; smClock = (N $p[3]); smClockMax = (N $p[4]); memClock = (N $p[5]); memClockMax = (N $p[6]); powerW = (N $p[7]); powerLimitW = (N $p[8]); tempC = (N $p[9]); util = (N $p[10]); utilMem = (N $p[11]); pcieGen = (N $p[12]); pcieWidth = (N $p[13]); vramUsedMb = (N $p[14]); vramTotalMb = (N $p[15]); encSessions = (N $p[16]); encFps = (N $p[17]); encLatencyMs = (N $p[18]) }
    if ($hasThrottle) { $d.gpu.throttle = $p[19] }
    $e = Smi-Enc; if ($e) { $d.gpu.utilEnc = $e.enc; $d.gpu.utilDec = $e.dec }
  }
  # Screens
  try { $d.pnpDisplay = @(Get-PnpDevice -Class Display -ErrorAction Stop | ForEach-Object { @{ name = $_.FriendlyName; id = $_.InstanceId; status = [string]$_.Status } }) } catch { }
  try { $d.displays = @(Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution } | ForEach-Object { @{ name = $_.Name; w = [int]$_.CurrentHorizontalResolution; h = [int]$_.CurrentVerticalResolution; hz = [int]$_.CurrentRefreshRate } }) } catch { }
  try { $d.monitors = @(Get-CimInstance -Namespace 'root\wmi' -ClassName WmiMonitorBasicDisplayParams -ErrorAction Stop).Count } catch { }
  # Sunshine
  $sun = @{}
  try { if (Test-Path $SunshineExe) { $sun.version = [string](& $SunshineExe --version 2>&1 | Select-Object -First 1) } } catch { }
  try { $sv = Get-CimInstance Win32_Service -Filter "Name='SunshineService'"; if ($sv) { $sun.service = $sv.State; $sun.startType = $sv.StartMode; $sun.account = $sv.StartName } else { $sun.service = 'NotInstalled' } } catch { }
  if (Test-Path $SunshineConf) { $sun.config = @(Get-Content $SunshineConf -ErrorAction SilentlyContinue | Where-Object { $_.Trim() -and $_.Trim() -notmatch '^#' } | ForEach-Object { Scrub $_ }) }
  $sun.logTail = Tail-Lines $SunshineLog 250 60000
  $d.sunshine = $sun
  # Programs
  try {
    $pp = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | Sort-Object PercentProcessorTime -Descending | Select-Object -First 8)
    $d.procs = @($pp | ForEach-Object { @{ name = ($_.Name -replace '#\d+$', ''); cpu = [int]$_.PercentProcessorTime; memMb = [int]($_.WorkingSetPrivate / 1MB) } })
  } catch { }
  try {
    $watch = @('nvsphelper64', 'nvcontainer', 'nvidia share', 'gamebar', 'gamebarpresencewriter', 'obs64', 'discord', 'rtss')
    $d.overlays = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName.ToLower() } | Where-Object { $watch -contains $_ } | Sort-Object -Unique)
  } catch { }
  # Windows errors from the last day (graphics, hardware, hangs)
  try {
    $ev = @(Get-WinEvent -FilterHashtable @{ LogName = @('System', 'Application'); Level = @(1, 2); StartTime = (Get-Date).AddHours(-24) } -MaxEvents 300 -ErrorAction Stop)
    $d.events = @($ev | Group-Object { '{0}|{1}' -f $_.ProviderName, $_.Id } | Sort-Object Count -Descending | Select-Object -First 10 | ForEach-Object { @{ provider = $_.Group[0].ProviderName; id = $_.Group[0].Id; count = $_.Count; sample = (([string]$_.Group[0].Message) -replace '\s+', ' ').Trim() } })
  } catch { $d.events = @() }
  $id = Send-Report $c.id 'diagnose' $d
  return @($true, 'Diagnostics collected. Open the Diagnose tab to read them.')
}

# ---------------------------------------------------------------------------
# Record: per-second samples while you stream, sent live and saved
# ---------------------------------------------------------------------------
function Do-Record($c) {
  $sec = [int]$c.args.seconds
  $n = Get-NetInfo
  $gw = $n.gateway
  $ping = $null; if ($gw) { $ping = New-Object Net.NetworkInformation.Ping }
  $S = @{ gpuUtil = @(); encUtil = @(); smClock = @(); powerW = @(); tempC = @(); cpu = @(); rxMbps = @(); txMbps = @(); pingMs = @(); streaming = @() }
  $throttle = @{}; $lost = 0; $smMax = $null; $batch = @(); $prev = $null; $prevAt = $null
  $fields = 'utilization.gpu,clocks.sm,power.draw,temperature.gpu,encoder.stats.sessionCount,clocks.max.sm,clocks_throttle_reasons.active'
  $hasThrottle = $true
  for ($i = 0; $i -lt $sec; $i++) {
    $tick = Get-Date
    $x = @{}
    $p = Smi $fields
    if (-not $p -and $hasThrottle) { $hasThrottle = $false; $fields = 'utilization.gpu,clocks.sm,power.draw,temperature.gpu,encoder.stats.sessionCount,clocks.max.sm'; $p = Smi $fields }
    if ($p) {
      $x.gpuUtil = N $p[0]; $x.smClock = N $p[1]; $x.powerW = N $p[2]; $x.tempC = N $p[3]
      $x.streaming = $(if ((N $p[4]) -gt 0) { 1 } else { 0 })
      if ($null -eq $smMax) { $smMax = N $p[5] }
      if ($hasThrottle -and $p.Count -gt 6) { $throttle[$p[6]] = $true }
    }
    $e = Smi-Enc; if ($e) { $x.encUtil = $e.enc }
    try { $x.cpu = [int](Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime } catch { }
    try {
      $st = Get-NetAdapterStatistics -Name $n.name; $now = Get-Date
      if ($prev) { $dt = ($now - $prevAt).TotalSeconds; if ($dt -gt 0) { $x.rxMbps = [Math]::Round((($st.ReceivedBytes - $prev.ReceivedBytes) * 8 / 1000000) / $dt, 1); $x.txMbps = [Math]::Round((($st.SentBytes - $prev.SentBytes) * 8 / 1000000) / $dt, 1) } }
      $prev = $st; $prevAt = $now
    } catch { }
    if ($ping) { try { $r = $ping.Send($gw, 800); if ($r.Status -eq 'Success') { $x.pingMs = [int]$r.RoundtripTime } else { $lost++ } } catch { $lost++ } }
    foreach ($k in @($S.Keys)) { if ($null -ne $x[$k]) { $S[$k] += $x[$k] } }   # a copy of the keys: a hashtable can't be changed while it is walked
    $x.t = $i
    $batch += $x
    if ($batch.Count -ge 2) { try { [void](Post 'live' @{ samples = $batch } 10) } catch { }; $batch = @() }
    $script:lastBeat = Get-Date
    $left = 1000 - ((Get-Date) - $tick).TotalMilliseconds
    if ($left -gt 0) { Start-Sleep -Milliseconds ([int]$left) }
  }
  if ($batch.Count) { try { [void](Post 'live' @{ samples = $batch } 10) } catch { } }
  $data = @{ at = (Get-Date).ToUniversalTime().ToString('s') + 'Z'; seconds = $sec; series = $S; throttle = @($throttle.Keys); smClockMax = $smMax; pingLost = $lost; nic = $n.name }
  [void](Send-Report $c.id 'record' $data)
  return @($true, ('Recorded {0} seconds. Open the Diagnose tab to read the result.' -f $sec))
}

function Do-Logs($c) {
  $n = [int]$c.args.lines
  $d = @{ at = (Get-Date).ToUniversalTime().ToString('s') + 'Z'; sunshine = (Tail-Lines $SunshineLog $n 150000); agent = (Tail-Lines $Log 200 30000) }
  [void](Send-Report $c.id 'logs' $d)
  return @($true, ('Collected {0} Sunshine log lines and the agent log.' -f @($d.sunshine).Count))
}

# ---------------------------------------------------------------------------
# Tuning actions (each reversible, each logged by GGGH)
# ---------------------------------------------------------------------------
function Do-PowerPlan($plan) {
  $prevFile = Join-Path $Dir 'power-prev.txt'
  $cur = ''; if (((& powercfg /getactivescheme) | Out-String) -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') { $cur = $Matches[1].ToLower() }
  if ($plan -eq 'restore') {
    $back = '381b4222-f694-41f0-9685-ff5bb260df2e'
    if (Test-Path $prevFile) { $back = (Get-Content $prevFile -Raw).Trim() }
    & powercfg /setactive $back | Out-Null
    return @(($LASTEXITCODE -eq 0), ('Power plan put back ({0}).' -f $back))
  }
  if ($cur -eq $HighPerf) { return @($true, 'The power plan is already High performance.') }
  if ($cur) { Set-Content -Path $prevFile -Value $cur -Encoding ASCII }
  & powercfg /setactive $HighPerf 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $dup = (& powercfg -duplicatescheme $HighPerf) | Out-String
    if ($dup -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') { & powercfg /setactive $Matches[1] | Out-Null }
  }
  return @(($LASTEXITCODE -eq 0), 'Power plan set to High performance. Use "Put it back" to undo.')
}

function Do-GpuClocks($action) {
  if ($action -eq 'reset') { $o = (& nvidia-smi -rgc 2>&1) | Out-String; return @(($LASTEXITCODE -eq 0), ('GPU clocks unlocked. ' + $o.Trim())) }
  $p = Smi 'clocks.max.sm'
  if (-not $p) { return @($false, 'Could not read the GPU maximum clock.') }
  $max = [int](N $p[0]); $min = [int]($max * 0.85)
  $o = (& nvidia-smi -lgc ('{0},{1}' -f $min, $max) 2>&1) | Out-String
  return @(($LASTEXITCODE -eq 0), ('GPU clocks locked to {0}-{1} MHz until the PC restarts (or you unlock them). {2}' -f $min, $max, $o.Trim()))
}

function Do-SunshineConfig($key, $value, $noRestart) {
  if (-not (Test-Path $SunshineConf)) { return @($false, 'Sunshine config file not found.') }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item $SunshineConf ($SunshineConf + '.gggh-' + $stamp) -Force
  Get-ChildItem -Path ($SunshineConf + '.gggh-*') | Sort-Object Name -Descending | Select-Object -Skip 5 | Remove-Item -Force -ErrorAction SilentlyContinue
  $lines = @(Get-Content $SunshineConf -ErrorAction SilentlyContinue)
  $out = @(); $found = $false
  foreach ($l in $lines) {
    if ($l -match ('^\s*' + [regex]::Escape($key) + '\s*=')) { if (-not $found) { $out += ('{0} = {1}' -f $key, $value); $found = $true } } else { $out += $l }
  }
  if (-not $found) { $out += ('{0} = {1}' -f $key, $value) }
  [IO.File]::WriteAllLines($SunshineConf, [string[]]$out, (New-Object Text.UTF8Encoding $false))
  if (-not $noRestart) { Restart-Service -Name 'SunshineService' -Force }
  return @($true, ('Sunshine setting {0} = {1} saved and Sunshine restarted. The previous config is kept; "Restore previous Sunshine config" undoes it.' -f $key, $value))
}

function Do-SunshineConfigRestore {
  $b = Get-ChildItem -Path ($SunshineConf + '.gggh-*') -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $b) { return @($false, 'There is no earlier Sunshine config saved by GGGH.') }
  Copy-Item $b.FullName $SunshineConf -Force
  Remove-Item $b.FullName -Force
  Restart-Service -Name 'SunshineService' -Force
  return @($true, 'The previous Sunshine config is back and Sunshine restarted.')
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
    Beat
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
  if ($action -eq 'set' -or $action -eq 'headless') { $req.width = [int]$c.args.width; $req.height = [int]$c.args.height; $req.fps = [int]$c.args.fps }
  ($req | ConvertTo-Json -Compress) | Set-Content (Join-Path $DispDir 'request.json') -Encoding UTF8
  Start-ScheduledTask -TaskName 'GGGH Display' | Out-Null
  for ($i = 0; $i -lt 70; $i++) {
    Start-Sleep -Milliseconds 500
    Beat
    $rp = Join-Path $DispDir 'result.json'
    if (Test-Path $rp) {
      try { $r = Get-Content $rp -Raw | ConvertFrom-Json; if ($r.id -eq $c.id) { return @([bool]$r.ok, [string]$r.message) } } catch { }
    }
  }
  return @($false, 'Nobody is signed in to Windows on the PC (or it is locked), so its screen could not be changed.')
}

# ---------------------------------------------------------------------------
# Mirror / Headless. Headless = the PC's own screens off, a virtual display at
# the receiver's size. headless.json marks it; the watchdog puts the screens
# back if the stream is over, GGGH is out of reach, or the PC has restarted.
# ---------------------------------------------------------------------------
$HeadlessFile = Join-Path $Dir 'headless.json'
$script:lastOk = Get-Date
$script:idleSince = $null
$script:lastWatch = [datetime]::MinValue
$script:vdCache = $null
$script:vdAt = [datetime]::MinValue

function Get-VirtualInfo {
  if ($null -eq $script:vdCache -or ((Get-Date) - $script:vdAt).TotalMinutes -ge 5) {
    $info = @{ virtual = $false; state = ''; seen = @() }
    try {
      $disp = @(Get-PnpDevice -Class Display -ErrorAction Stop)
      $info.seen = @($disp | ForEach-Object { ('{0} [{1}]' -f $(if ($_.FriendlyName) { $_.FriendlyName } else { $_.InstanceId }), $_.Status) } | Select-Object -First 8)
      # The driver's device can have no friendly name at all: a device that is not on the PCI bus (ROOT\DISPLAY) is the software one.
      $v = @($disp | Where-Object { $_.InstanceId -like 'ROOT\DISPLAY*' -or $_.FriendlyName -match $VirtRe })
      if ($v.Count) {
        $ok = @($v | Where-Object { $_.Status -eq 'OK' })
        if ($ok.Count) { $info.virtual = $true; $info.state = 'OK' } else { $info.state = [string]$v[0].Status }
      }
    } catch { $info.state = 'could not look: ' + $_.Exception.Message }
    $script:vdCache = $info
    $script:vdAt = Get-Date
  }
  return $script:vdCache
}

function Run-Headless($c) {
  $r = Do-Display $c 'headless'
  if ($r[0]) {
    $pp = Do-PowerPlan 'high'
    $changed = ($pp[0] -and ([string]$pp[1] -notmatch 'already'))
    (@{ since = (Get-Date).ToString('s'); powerChanged = $changed } | ConvertTo-Json -Compress) | Set-Content $HeadlessFile -Encoding ASCII
    return @($true, ([string]$r[1] + $(if ($changed) { ' Power plan set to High performance while headless.' } else { '' })))
  }
  return $r
}

function Do-Restore($c) {
  $r = Do-Display $c 'restore'
  if ($r[0] -and (Test-Path $HeadlessFile)) {
    $back = $false
    try { $back = [bool](Get-Content $HeadlessFile -Raw | ConvertFrom-Json).powerChanged } catch { }
    Remove-Item $HeadlessFile -Force -ErrorAction SilentlyContinue
    if ($back) { $pp = Do-PowerPlan 'restore'; return @($true, ([string]$r[1] + ' Power plan put back.')) }
  }
  return $r
}

function Watch-Headless($st) {
  if (-not (Test-Path $HeadlessFile)) { $script:idleSince = $null; return }
  $why = $null
  if (((Get-Date) - $script:lastOk).TotalMinutes -ge 5) { $why = 'GGGH has been out of reach for 5 minutes' }
  try {
    $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
    if ((Get-Item $HeadlessFile).LastWriteTime -lt $boot) { $why = 'the PC restarted while it was headless' }
  } catch { }
  if ($st -and $st.gpu) {
    if ($st.streaming) { $script:idleSince = $null }
    elseif ($null -eq $script:idleSince) { $script:idleSince = Get-Date }
    elseif (((Get-Date) - $script:idleSince).TotalMinutes -ge 10) { $why = 'nobody has been streaming for 10 minutes' }
  }
  if (-not $why) { return }
  if (((Get-Date) - $script:lastWatch).TotalSeconds -lt 60) { return }
  $script:lastWatch = Get-Date
  Log ('headless watchdog: putting the screens back because ' + $why)
  $r = Do-Restore ([pscustomobject]@{ id = [guid]::NewGuid().ToString() })
  Log ('headless watchdog: ' + [string]$r[1])
  if ($r[0]) { $script:idleSince = $null }
}

# ---------------------------------------------------------------------------
# SSH: make sure this PC has an SSH server and the account's keys, and open
# connections through GGGH (no router changes). Nothing already there is changed
# except adding missing keys.
# ---------------------------------------------------------------------------
function Get-ConsoleUser {
  try { $u = [string](Get-CimInstance Win32_ComputerSystem).UserName; if ($u) { return $u } } catch { }
  return ''
}

function Get-SshInfo {
  $i = @{ installed = $false; running = $false; port = 22; user = '' }
  try {
    $sv = Get-Service -Name 'sshd' -ErrorAction Stop
    $i.installed = $true; $i.running = ($sv.Status -eq 'Running')
    $cf = Join-Path $env:ProgramData 'ssh\sshd_config'
    if (Test-Path $cf) { $m = Select-String -Path $cf -Pattern '^\s*Port\s+(\d+)' | Select-Object -First 1; if ($m) { $i.port = [int]$m.Matches[0].Groups[1].Value } }
  } catch { }
  $cu = Get-ConsoleUser
  if ($cu) { $i.user = ($cu -split '\\')[-1] }
  return $i
}

function Do-SshSetup($keys) {
  $msgs = @()
  $sv = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue
  if (-not $sv) {
    $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cap) { return @($false, 'This Windows has no OpenSSH Server to add (needs Windows 10 1809 or newer).') }
    $job = Start-Job -ScriptBlock { param($n) Add-WindowsCapability -Online -Name $n | Out-Null } -ArgumentList $cap.Name
    $t0 = Get-Date
    while ($job.State -eq 'Running' -and ((Get-Date) - $t0).TotalMinutes -lt 8) { Start-Sleep -Seconds 3; Beat }
    $sv = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue
    if (-not $sv) { return @($false, 'Windows did not add the OpenSSH Server. Add it in Settings > System > Optional features, then try again.') }
    $msgs += 'OpenSSH Server added.'
  } else { $msgs += 'OpenSSH Server was already there.' }
  try { Set-Service -Name 'sshd' -StartupType Automatic } catch { }
  if ((Get-Service -Name 'sshd').Status -ne 'Running') { Start-Service -Name 'sshd'; $msgs += 'Started it.' }
  if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue) -and -not (Get-NetFirewallRule -DisplayName 'GGGH SSH (home network)' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'GGGH SSH (home network)' -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress LocalSubnet -Action Allow | Out-Null
    $msgs += 'Allowed SSH from the home network only.'
  }
  $cu = Get-ConsoleUser
  $name = ($cu -split '\\')[-1]
  $list = @($keys | Where-Object { $_ })
  if (-not $list.Count) { $msgs += 'No SSH keys are saved in GGGH yet (Machines page, SSH access), so none were added.' }
  elseif (-not $name) { $msgs += 'Nobody is signed in to Windows, so the keys could not be added yet; try again once signed in.' }
  else {
    $admin = $false
    try { $admin = [bool](Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop | Where-Object { ($_.Name -split '\\')[-1] -ieq $name }) } catch { }
    if ($admin) { $file = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys' }
    else {
      $prof = (Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -like ('*\' + $name) } | Select-Object -First 1).LocalPath
      if (-not $prof) { $prof = Join-Path 'C:\Users' $name }
      New-Item -ItemType Directory -Force -Path (Join-Path $prof '.ssh') | Out-Null
      $file = Join-Path $prof '.ssh\authorized_keys'
    }
    $have = @(); if (Test-Path $file) { $have = @(Get-Content $file | ForEach-Object { $_.Trim() }) }
    $add = @($list | Where-Object { $have -notcontains $_.Trim() })
    if ($add.Count) { Add-Content -Path $file -Value ($add | ForEach-Object { $_.Trim() }) -Encoding ASCII }
    if ($admin) { & icacls.exe $file '/inheritance:r' '/grant' 'Administrators:F' '/grant' 'SYSTEM:F' | Out-Null }
    $msgs += ('{0} key(s) added for {1} ({2} already there).' -f $add.Count, $name, ($list.Count - $add.Count))
  }
  return @($true, ($msgs -join ' '))
}

function Test-TcpPort($h, $p) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $iar = $c.BeginConnect($h, [int]$p, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(2000) -and $c.Connected
    $c.Close()
    return $ok
  } catch { return $false }
}

# Everything about SSH on this PC that decides whether a connection through GGGH works.
function Do-SshDiagnose {
  $o = @()
  $i = Get-SshInfo
  $o += ('SSH server: {0}; port {1}; signed-in user "{2}".' -f $(if ($i.running) { 'running' } elseif ($i.installed) { 'installed but STOPPED' } else { 'NOT installed' }), $i.port, $i.user)
  try { $o += ('Service start type: ' + (Get-Service sshd -ErrorAction Stop).StartType) } catch { }
  $cf = Join-Path $env:ProgramData 'ssh\sshd_config'
  if (Test-Path $cf) {
    $keep = @(Get-Content $cf | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^(Port|ListenAddress|AddressFamily|PasswordAuthentication|PubkeyAuthentication|AllowUsers|AllowGroups|DenyUsers|DenyGroups|AuthorizedKeysFile|Match)\b' })
    $o += ('sshd_config (relevant lines): ' + $(if ($keep.Count) { $keep -join ' | ' } else { 'none (all defaults)' }))
  } else { $o += 'No sshd_config found.' }
  $n = Get-NetInfo
  $o += ('Answers on 127.0.0.1:{0}: {1}' -f $i.port, (Test-TcpPort '127.0.0.1' $i.port))
  if ($n.lanIp) { $o += ('Answers on {0}:{1}: {2}' -f $n.lanIp, $i.port, (Test-TcpPort $n.lanIp $i.port)) }
  try {
    $ls = @(Get-NetTCPConnection -State Listen -LocalPort $i.port -ErrorAction Stop | ForEach-Object { $_.LocalAddress })
    $o += ('Listening on: ' + $(if ($ls.Count) { $ls -join ', ' } else { 'nothing on that port' }))
  } catch { $o += ('Nothing is listening on port ' + $i.port) }
  $cu = Get-ConsoleUser; $name = ($cu -split '\\')[-1]
  if ($name) {
    $admin = $false
    try { $admin = [bool](Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop | Where-Object { ($_.Name -split '\\')[-1] -ieq $name }) } catch { }
    $file = $(if ($admin) { Join-Path $env:ProgramData 'ssh\administrators_authorized_keys' } else { 'C:\Users\' + $name + '\.ssh\authorized_keys' })
    $cnt = 0; if (Test-Path $file) { $cnt = @(Get-Content $file | Where-Object { $_.Trim() }).Count }
    $o += ('User {0} is {1}; keys file {2}: {3} key(s).' -f $name, $(if ($admin) { 'an administrator (uses the administrators file)' } else { 'a normal user' }), $file, $cnt)
  } else { $o += 'Nobody is signed in to Windows, so the keys file could not be checked.' }
  try {
    # Login lines ("Failed password for regan", "Accepted publickey ...") are what matters here; they hold no secrets, so only long key-like strings are cut.
    $ev = @(Get-WinEvent -LogName 'OpenSSH/Operational' -MaxEvents 14 -ErrorAction Stop | ForEach-Object { (($_.TimeCreated.ToString('HH:mm:ss')) + ' ' + (($_.Message -replace '\s+', ' ') -replace '[A-Za-z0-9+/=]{30,}', '[cut]')) })
    $o += ('Recent SSH server log: ' + ($ev -join ' || '))
  } catch { $o += 'SSH server log: nothing readable.' }
  try {
    $tl = @(Get-Content $Log -Tail 200 -ErrorAction Stop | Where-Object { $_ -match 'ssh tunnel|tunnel-open|command tunnel' } | Select-Object -Last 10)
    $o += ('Agent log, SSH tunnels: ' + $(if ($tl.Count) { $tl -join ' || ' } else { 'no tunnel has been opened yet' }))
  } catch { }
  return @($true, ($o -join [Environment]::NewLine))
}

function Do-TunnelOpen($sid, $port) {
  if ($sid -notmatch '^[0-9a-f-]{36}$' -or $port -lt 1 -or $port -gt 65535) { return @($false, 'Bad tunnel request.') }
  # sshd may listen only on the LAN address (ListenAddress in sshd_config), so use whichever of loopback / LAN address answers.
  $target = '127.0.0.1'
  if (-not (Test-TcpPort '127.0.0.1' $port)) {
    $n = Get-NetInfo
    if ($n.lanIp -and (Test-TcpPort $n.lanIp $port)) { $target = $n.lanIp }
  }
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $AgentFile, '-Mode', 'tunnel', '-Sid', $sid, '-Port', [string]$port, '-TargetHost', $target) -WindowStyle Hidden
  return @($true, 'SSH connection opened.')
}

# ---------------------------------------------------------------------------
# Away access: let the router open Sunshine's ports and keep its admin page off the internet.
# ---------------------------------------------------------------------------
function Do-AwayPrepare {
  $msgs = @(); $ok = $true
  try {
    $n = 0
    Get-NetConnectionProfile -ErrorAction Stop | Where-Object { $_.NetworkCategory -eq 'Public' -and $_.IPv4Connectivity -ne 'Disconnected' } | ForEach-Object { Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private; $n++ }
    if ($n) { $msgs += 'Network set to Private (Public blocks Sunshine).' }
  } catch { $msgs += ('Could not check the network type: ' + $_.Exception.Message) }
  $r = Do-SunshineConfig 'origin_web_ui_allowed' 'lan' $true
  if (-not $r[0]) { $ok = $false; $msgs += [string]$r[1] } else { $msgs += 'Sunshine admin page limited to the home network.' }
  if ($ok) {
    $r = Do-SunshineConfig 'upnp' 'enabled'
    if (-not $r[0]) { $ok = $false; $msgs += [string]$r[1] } else { $msgs += 'Sunshine will ask the router to open its ports (UPnP).' }
  }
  return @($ok, ($msgs -join ' '))
}

# What the router and the network say about reaching this PC from outside.
function Do-AwayDiagnose {
  $o = @()
  try {
    $nat = New-Object -ComObject HNetCfg.NATUPnP
    $m = $nat.StaticPortMappingCollection
    if ($null -eq $m) { $o += 'UPnP: the router did not answer, so it is off or not supported. Ports have to be forwarded by hand.' }
    else {
      $items = @($m | ForEach-Object { ('{0}/{1} to {2}:{3}' -f $_.ExternalPort, $_.Protocol, $_.InternalClient, $_.InternalPort) })
      if ($items.Count) { $o += ('UPnP: the router answered and holds {0} port mapping(s): {1}' -f $items.Count, ($items -join ', ')) }
      else { $o += 'UPnP: the router answered but Sunshine has no port mappings in it (restart Sunshine, then check again).' }
    }
  } catch { $o += ('UPnP check failed: ' + $_.Exception.Message) }
  try {
    $ul = @(Select-String -Path $SunshineLog -Pattern 'upnp' -ErrorAction Stop | Select-Object -Last 5 | ForEach-Object { Scrub $_.Line })
    if ($ul.Count) { $o += ('Sunshine log, UPnP lines: ' + ($ul -join ' || ')) } else { $o += 'Sunshine log: no UPnP lines at all (is upnp set and Sunshine restarted?).' }
  } catch { $o += 'Sunshine log: could not read it.' }
  try {
    $tr = @(& tracert.exe -d -h 4 -w 800 1.1.1.1 2>&1 | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -match '^\d+\s' })
    $o += ('First hops to the internet: ' + ($tr -join ' | '))
  } catch { $o += 'Route check failed.' }
  try {
    $v6 = @(Get-NetIPAddress -AddressFamily IPv6 -ErrorAction Stop | Where-Object { $_.IPAddress -notmatch '^(fe80|::1|fd|fc)' } | ForEach-Object { $_.IPAddress })
    if ($v6.Count) { $o += ('IPv6 addresses: ' + ($v6 -join ', ')) } else { $o += 'IPv6: none.' }
  } catch { }
  try {
    $fw = @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction Stop | Where-Object { $_.DisplayName -match 'Sunshine' } | ForEach-Object { $_.DisplayName })
    $o += ('Windows firewall rules for Sunshine: ' + $(if ($fw.Count) { $fw -join ', ' } else { 'none found' }))
  } catch { }
  return @($true, ($o -join [Environment]::NewLine))
}

function Do-Script($text) {
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($text))
  $o = Join-Path $Dir 'script.out'; $e = Join-Path $Dir 'script.err'
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $enc) -RedirectStandardOutput $o -RedirectStandardError $e -PassThru -WindowStyle Hidden
  $t0 = Get-Date
  while (-not $p.WaitForExit(3000)) {
    Beat
    if (((Get-Date) - $t0).TotalSeconds -gt 60) { try { $p.Kill() } catch { }; return @($false, 'The script ran for over 60 seconds and was stopped.') }
  }
  $out = (Get-Content $o -Raw -ErrorAction SilentlyContinue) + (Get-Content $e -Raw -ErrorAction SilentlyContinue)
  Remove-Item $o, $e -Force -ErrorAction SilentlyContinue
  if ($out.Length -gt 3500) { $out = $out.Substring(0, 3500) + ' ...(cut)' }
  return @(($p.ExitCode -eq 0), ('Exit code {0}. {1}' -f $p.ExitCode, $out))
}

function Run-Command($c) {
  Log ('command ' + $c.kind)
  try {
    switch ($c.kind) {
      'refresh' { $script:vdCache = $null; Report $c.id $true 'Status refreshed.' }
      'sunshine-restart' { Restart-Service -Name 'SunshineService' -Force; Report $c.id $true 'Sunshine restarted.' }
      'sunshine-pin' { $r = Do-Pin ([string]$c.args.pin) ([string]$c.args.name); Report $c.id $r[0] $r[1] }
      'sunshine-config' { $r = Do-SunshineConfig ([string]$c.args.key) ([string]$c.args.value); Report $c.id $r[0] $r[1] }
      'sunshine-config-restore' { $r = Do-SunshineConfigRestore; Report $c.id $r[0] $r[1] }
      'display-set' { $r = Do-Display $c 'set'; Report $c.id $r[0] $r[1] }
      'display-restore' { $r = Do-Restore $c; Report $c.id $r[0] $r[1] }
      'display-headless' { $r = Run-Headless $c; Report $c.id $r[0] $r[1] }
      'diagnose' { $r = Do-Diagnose $c; Report $c.id $r[0] $r[1] }
      'record' { $r = Do-Record $c; Report $c.id $r[0] $r[1] }
      'logs' { $r = Do-Logs $c; Report $c.id $r[0] $r[1] }
      'power-plan' { $r = Do-PowerPlan ([string]$c.args.plan); Report $c.id $r[0] $r[1] }
      'gpu-clocks' { $r = Do-GpuClocks ([string]$c.args.action); Report $c.id $r[0] $r[1] }
      'script' { $r = Do-Script ([string]$c.args.script); Report $c.id $r[0] $r[1] }
      'ssh-setup' { $r = Do-SshSetup @($c.args.keys); Report $c.id $r[0] $r[1] }
      'tunnel-open' { $r = Do-TunnelOpen ([string]$c.args.sid) ([int]$c.args.port); Report $c.id $r[0] $r[1] }
      'away-prepare' { $r = Do-AwayPrepare; Report $c.id $r[0] $r[1] }
      'away-diagnose' { $r = Do-AwayDiagnose; Report $c.id $r[0] $r[1] }
      'ssh-diagnose' { $r = Do-SshDiagnose; Report $c.id $r[0] $r[1] }
      'sleep' { Report $c.id $true 'Going to sleep.'; Start-Sleep -Seconds 2; Start-Process -FilePath 'rundll32.exe' -ArgumentList 'powrprof.dll,SetSuspendState 0,1,0' }
      'restart' { Report $c.id $true 'Restarting.'; & shutdown.exe /r /t 5 /c 'Restart requested from GGGH' }
      'shutdown' { Report $c.id $true 'Shutting down.'; & shutdown.exe /s /t 5 /c 'Shutdown requested from GGGH' }
      default { Report $c.id $false ('Unknown command: ' + $c.kind) }
    }
  } catch { Report $c.id $false ('Failed: ' + $_.Exception.Message) }
}

# ---------------------------------------------------------------------------
# Updating itself. GGGH says which file differs and what its SHA-256 should be.
# Safety: the hash must match, the new file must PARSE, the old one is kept as
# .bak, and gggh-boot.ps1 puts it back if the new one keeps crashing.
# ---------------------------------------------------------------------------
function Try-Update($list) {
  $triedFile = Join-Path $Dir 'update.tried'
  $changedAgent = $false; $changedBoot = $false
  foreach ($u in @($list)) {
    $name = [string]$u.file; $sha = ([string]$u.sha256).ToLower()
    if ($name -ne 'agent' -and $name -ne 'boot') { continue }
    if (Test-Path $triedFile) {
      $t = (Get-Content $triedFile -Raw).Trim() -split '\|'
      if ($t[0] -eq $sha -and ((Get-Date) - [datetime]::FromBinary([int64]$t[1])).TotalHours -lt 6) { continue }
    }
    $target = $(if ($name -eq 'boot') { $BootFile } else { $AgentFile })
    $tmp = $target + '.new'
    try {
      Set-Content -Path $triedFile -Value ('{0}|{1}' -f $sha, (Get-Date).ToBinary()) -Encoding ASCII
      Invoke-WebRequest -UseBasicParsing -Uri ($cfg.api + '/local-agent/' + $name + '.ps1') -OutFile $tmp -TimeoutSec 60
      # A mismatch can just mean GGGH was mid-deploy (old and new copies running side by side): try again in about 5 minutes, not 6 hours.
      if ((Hash-Of $tmp) -ne $sha) { Log ('update ' + $name + ': the download did not match its fingerprint; ignored, will retry soon'); Set-Content -Path $triedFile -Value ('{0}|{1}' -f $sha, (Get-Date).AddMinutes(-355).ToBinary()) -Encoding ASCII; Remove-Item $tmp -Force -ErrorAction SilentlyContinue; continue }
      try { [void][scriptblock]::Create((Get-Content $tmp -Raw)) } catch { Log ('update ' + $name + ': the new file does not parse; ignored'); Remove-Item $tmp -Force -ErrorAction SilentlyContinue; continue }
      Copy-Item $target ($target + '.bak') -Force
      Move-Item $tmp $target -Force
      Set-Content -Path (Join-Path $Dir 'update.pending') -Value $sha -Encoding ASCII
      Log ('updated ' + $name)
      if ($name -eq 'agent') { $changedAgent = $true } else { $changedBoot = $true }
    } catch { Log ('update ' + $name + ' failed: ' + $_.Exception.Message); Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  }
  if ($changedBoot) {
    # The running wrapper is the old one: restart the whole task so the new wrapper (and agent) take over.
    Log 'restarting to use the new wrapper'
    Stop-ScheduledTask -TaskName 'GGGH Agent'
    Start-ScheduledTask -TaskName 'GGGH Agent'
    exit 0
  }
  if ($changedAgent) { Log 'restarting to use the new agent'; exit 0 }
}

Log ('agent ' + $AgentVersion + ' starting')
$fails = 0
while ($true) {
  $t0 = Get-Date
  try {
    $st = Get-Status
    $r = Post 'poll' $st 45
    $fails = 0
    $script:lastOk = Get-Date
    $pending = Join-Path $Dir 'update.pending'
    if (Test-Path $pending) { Remove-Item $pending -Force -ErrorAction SilentlyContinue }
    if (@($r.update).Count) { Try-Update $r.update }
    foreach ($c in @($r.commands)) { Run-Command $c }
    try { Watch-Headless $st } catch { Log ('headless watchdog failed: ' + $_.Exception.Message) }
    if (((Get-Date) - $t0).TotalSeconds -lt 1.5) { Start-Sleep -Seconds 2 }
  } catch {
    $fails++
    $code = 0; try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    Log ('poll failed ({0}): {1}' -f $code, $_.Exception.Message)
    try { Watch-Headless $null } catch { }
    if ($code -eq 401) { Start-Sleep -Seconds 60 } else { Start-Sleep -Seconds ([Math]::Min(60, 3 * $fails)) }
  }
}
`;

export const BOOT_PS1 = String.raw`# GGGH agent wrapper: keeps the agent running, and puts the previous version back if a fresh update keeps crashing.
$Dir = Join-Path $env:ProgramData 'GGGH'
$Agent = Join-Path $Dir 'gggh-agent.ps1'
$Bak = $Agent + '.bak'
$Pending = Join-Path $Dir 'update.pending'
$Log = Join-Path $Dir 'agent.log'
function Log($m) { try { Add-Content -Path $Log -Value ('{0} boot: {1}' -f (Get-Date -Format 's'), $m) } catch { } }
$fast = 0
while ($true) {
  $t0 = Get-Date
  try {
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $Agent) -WindowStyle Hidden -PassThru -Wait
  } catch { Log ('could not start the agent: ' + $_.Exception.Message) }
  $ran = ((Get-Date) - $t0).TotalSeconds
  if ($ran -lt 90) { $fast++ } else { $fast = 0 }
  if ($fast -ge 3 -and (Test-Path $Pending) -and (Test-Path $Bak)) {
    Copy-Item $Bak $Agent -Force
    Remove-Item $Pending -Force -ErrorAction SilentlyContinue
    Log 'the updated agent kept stopping: the previous version was put back'
    $fast = 0
  }
  Start-Sleep -Seconds 5
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
Invoke-WebRequest -UseBasicParsing -Uri ($Api + '/local-agent/boot.ps1') -OutFile (Join-Path $Dir 'gggh-boot.ps1')

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
$bootPath = Join-Path $Dir 'gggh-boot.ps1'
$arg = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $bootPath   # the agent runs inside this small wrapper, which can roll back a bad update
$dispArg = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Mode display' -f $agentPath
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
  Action = (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $dispArg)
  Principal = (New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited)
}
Register-ScheduledTask @displayTask | Out-Null
Stop-ScheduledTask -TaskName 'GGGH Agent' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'GGGH Agent'

Write-Host ''
Write-Host 'Done. Go back to GGGH: this PC should show as online within a few seconds.' -ForegroundColor Green
Write-Host 'The agent keeps itself up to date from GGGH.'
Write-Host ('Sunshine admin page (on this PC): https://localhost:47990 (user name: {0}; the password is saved in the agent file)' -f $user)
Write-Host 'For waking this PC from sleep, use a wired network connection.'
`;

export const VDISPLAY_PS1 = String.raw`# GGGH: install a virtual display on this PC (for Headless / Gaming mode). Run in an ELEVATED PowerShell.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Please run this in an elevated PowerShell: right-click Start, then "Terminal (Admin)".' -ForegroundColor Yellow; return }
$re = 'Virtual|MttVDD|IddSample|IDD|Indirect|Parsec'
function Has-Virtual { return [bool](@(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' -and ($_.InstanceId -like 'ROOT\DISPLAY*' -or $_.FriendlyName -match $re) }).Count) }
function Show-Devices { Write-Host 'Display devices Windows lists:'; Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ('  {0} {1} [{2}]' -f $_.FriendlyName, $_.InstanceId, $_.Status) } }
if (Has-Virtual) { Write-Host 'A virtual display is already installed. Nothing to do.' -ForegroundColor Green; Show-Devices; return }

$tmp = Join-Path $env:TEMP ('gggh-vdd-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Write-Host '1/4 Downloading the tool that adds the driver (NefCon)...'
  $nefZip = Join-Path $tmp 'nefcon.zip'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/nefarius/nefcon/releases/download/v1.14.0/nefcon_v1.14.0.zip' -OutFile $nefZip
  Expand-Archive -Path $nefZip -DestinationPath (Join-Path $tmp 'nefcon') -Force
  $nef = Get-ChildItem -Path (Join-Path $tmp 'nefcon') -Recurse -Filter 'nefconw.exe' | Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1
  if (-not $nef) { throw 'nefconw.exe was not in the NefCon download.' }

  Write-Host '2/4 Finding the latest Virtual Display Driver release...'
  $rel = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/VirtualDrivers/Virtual-Display-Driver/releases/latest' -Headers @{ 'User-Agent' = 'gggh' }
  $inf = $null
  foreach ($a in @($rel.assets | Where-Object { $_.name -match '\.zip$' -and $_.name -notmatch '(?i)arm' })) {
    $z = Join-Path $tmp ('asset-' + $a.id + '.zip'); $d = Join-Path $tmp ('asset-' + $a.id)
    Write-Host ('   trying ' + $a.name)
    Invoke-WebRequest -UseBasicParsing -Uri $a.browser_download_url -OutFile $z
    Expand-Archive -Path $z -DestinationPath $d -Force
    $inf = Get-ChildItem -Path $d -Recurse -Filter 'MttVDD.inf' | Select-Object -First 1
    if ($inf) { break }
  }
  if (-not $inf) { throw 'No driver (MttVDD.inf) was found in the latest release downloads.' }

  Write-Host '3/4 Trusting the driver publisher and adding the driver...'
  $cat = Get-ChildItem -Path $inf.DirectoryName -Filter '*.cat' | Select-Object -First 1
  if ($cat) {
    $cert = (Get-AuthenticodeSignature -FilePath $cat.FullName).SignerCertificate
    if ($cert) {
      $cer = Join-Path $tmp 'publisher.cer'
      [IO.File]::WriteAllBytes($cer, $cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
      Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\LocalMachine\TrustedPublisher' | Out-Null
    }
  }
  $class = '4d36e968-e325-11ce-bfc1-08002be10318'
  & $nef.FullName --create-device-node --hardware-id 'Root\MttVDD' --class-name 'Display' --class-guid $class
  & $nef.FullName --install-driver --inf-path $inf.FullName
  Start-Sleep -Seconds 4
  Write-Host '4/4 Checking...'
} catch {
  Write-Host ('Something went wrong: ' + $_.Exception.Message) -ForegroundColor Yellow
} finally {
  Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host ''
if (Has-Virtual) {
  Write-Host 'Done. The virtual display is installed; GGGH will see it within a few minutes (press Refresh on the PC card).' -ForegroundColor Green
  Write-Host 'Its list of resolutions is in C:\VirtualDisplayDriver\vdd_settings.xml. Add your TV and screen sizes there if Headless says a mode is missing.'
} else {
  Write-Host 'The virtual display did not show up. Copy everything above and paste it to Claude. By hand: github.com/VirtualDrivers/Virtual-Display-Driver (Virtual Driver Control, then click Install).' -ForegroundColor Yellow
}
Show-Devices
`;

const sha256 = (s: string) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
/** What GGGH tells agents to compare themselves against (their files are the same text, byte for byte). */
export const AGENT_SHA256 = sha256(AGENT_PS1);
export const BOOT_SHA256 = sha256(BOOT_PS1);
