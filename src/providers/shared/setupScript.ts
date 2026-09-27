/**
 * ============================================================================
 * src/providers/shared/setupScript.ts — THE SCRIPT THAT TURNS A BLANK UBUNTU VM
 *                                       INTO A GAME-STREAMING MACHINE (ANY CLOUD)
 * ============================================================================
 *
 * HOW IT GETS THERE
 * -----------------
 * Every cloud can run a script when a new machine first boots:
 *   Google Cloud  "startup-script" metadata
 *   AWS           EC2 "user data"
 *   Azure         "custom data" (cloud-init)
 *   Oracle        "user_data" metadata (cloud-init)
 * We hand this script to whichever it is. There's no SSH from the backend —
 * the machine sets itself up. Because some clouds only run that script on
 * the FIRST boot, it installs itself as a systemd service
 * (cloudgaming-setup.service) so it also runs after the driver reboot, and
 * on every later boot (finished steps are skipped).
 *
 * HOW WE WATCH IT
 * ---------------
 * Every stage prints a line like
 *     CLOUDGAMING_STAGE 40 drivers Installing NVIDIA driver…
 * to the machine's SERIAL CONSOLE (/dev/ttyS0). Every cloud lets you read
 * that through its API (Google getSerialPortOutput, AWS GetConsoleOutput,
 * Azure boot diagnostics, Oracle console history), so each provider's
 * getSetupProgress() can show a progress bar without logging in.
 * A full log is also kept on the machine at /var/log/cloudgaming-setup.log.
 *
 * WHAT IT INSTALLS (Ubuntu 22.04)
 * -------------------------------
 *   1. NVIDIA driver (then reboots once so it loads)
 *   2. A virtual screen: Xorg configured for the GPU with no monitor attached
 *   3. A light desktop (XFCE) + audio (PulseAudio), running as user "gamer"
 *   4. Sunshine — the streaming server Moonlight connects to
 *   5. Steam
 *   6. Sets Sunshine's web-admin login (every boot)
 *
 * ⚠️  FIRST VERSION: written carefully but not yet run end to end on every
 * GPU/cloud combination. If a stage fails, the progress panel shows which
 * one, and the log file above says why.
 * ============================================================================
 */

export interface SetupScriptOptions {
  sunshineUsername: string;   // letters/digits only
  sunshinePassword: string;   // base64url characters only
  /** Ubuntu package for the NVIDIA driver. Default: the 535 "-server" (datacenter) branch, as CloudyPad uses — suits T4 / L4 / A10G / A10. */
  driverPackage?: string;
}

/** Only allow characters that are safe inside single quotes in bash. */
function bashSafe(value: string, what: string): string {
  if (!/^[A-Za-z0-9_.@+=-]+$/.test(value)) throw new Error(`Unsafe characters in ${what}`);
  return value;
}

/**
 * Build the setup script for one machine. The Sunshine login is baked in
 * (the script file is readable only by root on the machine).
 */
export function buildSetupScript(opts: SetupScriptOptions): string {
  const user = bashSafe(opts.sunshineUsername, 'Sunshine username');
  const pass = bashSafe(opts.sunshinePassword, 'Sunshine password');
  const driver = bashSafe(opts.driverPackage || 'nvidia-driver-535-server', 'driver package');
  return SCRIPT_TEMPLATE
    .replace('__SUN_USER__', user)
    .replace('__SUN_PASS__', pass)
    .replace('__DRIVER_PKG__', driver);
}

const SCRIPT_TEMPLATE = String.raw`#!/bin/bash
# CloudGaming Hub machine setup. Runs as root.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
STATE=/var/lib/cloudgaming
mkdir -p "$STATE"
SUN_USER='__SUN_USER__'
SUN_PASS='__SUN_PASS__'
DRIVER_PKG='__DRIVER_PKG__'
APT="apt-get -o DPkg::Lock::Timeout=900 -y"

# First run (from the cloud's boot hook): install ourselves as a systemd
# service that runs on every boot, start it, and hand over.
if [ "$(printenv CG_FROM_UNIT)" != "1" ]; then
  install -m 700 "$0" /usr/local/sbin/cloudgaming-setup.sh
  cat > /etc/systemd/system/cloudgaming-setup.service <<'UNIT'
[Unit]
Description=CloudGaming Hub machine setup
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
Environment=CG_FROM_UNIT=1
ExecStart=/usr/local/sbin/cloudgaming-setup.sh
RemainAfterExit=yes
TimeoutStartSec=0
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable cloudgaming-setup.service
  systemctl start --no-block cloudgaming-setup.service
  exit 0
fi

exec >> /var/log/cloudgaming-setup.log 2>&1
say() { echo "$1"; echo "$1" > /dev/ttyS0 2>/dev/null || true; echo "$1" > /dev/console 2>/dev/null || true; }
stage() { say "CLOUDGAMING_STAGE $1 $2 $3"; }
fail()  { say "CLOUDGAMING_STAGE $1 failed $2"; exit 1; }
done_step() { touch "$STATE/$1.done"; }
is_done()   { [ -f "$STATE/$1.done" ]; }

stage 5 boot "Machine booted, starting setup"

# ---- 1. NVIDIA driver -------------------------------------------------------
if ! is_done driver; then
  stage 10 packages "Updating package lists"
  $APT update || fail 10 "apt-get update failed"
  stage 20 drivers "Installing NVIDIA driver (5-10 minutes)"
  $APT install ubuntu-drivers-common linux-headers-$(uname -r) || fail 20 "could not install driver tools"
  $APT install "$DRIVER_PKG" || fail 20 "NVIDIA driver install failed"
  done_step driver
  stage 30 reboot "Driver installed, rebooting once to load it"
  sleep 2
  reboot
  exit 0
fi

stage 35 gpu "Checking the GPU"
if ! nvidia-smi >/dev/null 2>&1; then
  fail 35 "nvidia-smi can't see the GPU - driver did not load"
fi
say "GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader)"

# ---- 2+3. Desktop, virtual screen, audio ------------------------------------
if ! is_done desktop; then
  stage 45 desktop "Installing desktop, virtual screen and audio"
  $APT install xserver-xorg-core xinit xfce4 xfce4-terminal dbus-x11 \
    pulseaudio pulseaudio-utils mesa-utils x11-xserver-utils || fail 45 "desktop install failed"
  id gamer >/dev/null 2>&1 || useradd -m -s /bin/bash gamer
  usermod -aG video,audio,input,render gamer || true

  # Headless GPU: tell Xorg to use the NVIDIA card with no monitor attached.
  BUS=$(nvidia-smi --query-gpu=pci.bus_id --format=csv,noheader | head -1)
  # "00000000:00:04.0" (hex) -> "PCI:0:4:0" (decimal) for xorg.conf
  B=$(echo "$BUS" | cut -d: -f2); D=$(echo "$BUS" | cut -d: -f3 | cut -d. -f1); F=$(echo "$BUS" | cut -d. -f2)
  PCI="PCI:$((16#$B)):$((16#$D)):$((16#$F))"
  mkdir -p /etc/X11
  cat > /etc/X11/xorg.conf <<XORG
Section "ServerLayout"
    Identifier "layout"
    Screen 0 "screen"
EndSection
Section "Device"
    Identifier "gpu"
    Driver "nvidia"
    BusID "$PCI"
    Option "AllowEmptyInitialConfiguration" "True"
    Option "UseDisplayDevice" "None"
EndSection
Section "Screen"
    Identifier "screen"
    Device "gpu"
    DefaultDepth 24
    SubSection "Display"
        Depth 24
        Virtual 1920 1080
    EndSubSection
EndSection
XORG

  cat > /etc/systemd/system/cloudgaming-desktop.service <<'UNIT'
[Unit]
Description=CloudGaming virtual desktop
After=network-online.target
[Service]
User=gamer
PAMName=login
Environment=XDG_RUNTIME_DIR=/run/user/1001
ExecStartPre=+/bin/bash -c 'mkdir -p /run/user/1001 && chown gamer:gamer /run/user/1001'
ExecStart=/usr/bin/xinit /usr/bin/startxfce4 -- :0 vt7 -nolisten tcp
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
  # Make the unit use gamer's real uid (useradd may not give 1001).
  GUID=$(id -u gamer)
  sed -i "s#/run/user/1001#/run/user/$GUID#g" /etc/systemd/system/cloudgaming-desktop.service
  # Allow a non-console user to start X.
  echo -e "allowed_users=anybody\nneeds_root_rights=yes" > /etc/X11/Xwrapper.config
  $APT install xserver-xorg-legacy || true
  systemctl daemon-reload
  systemctl enable cloudgaming-desktop
  done_step desktop
fi
systemctl start cloudgaming-desktop || true

# ---- 4. Sunshine ------------------------------------------------------------
if ! is_done sunshine; then
  stage 65 sunshine "Installing Sunshine streaming server"
  curl -fsSL -o /tmp/sunshine.deb \
    https://github.com/LizardByte/Sunshine/releases/latest/download/sunshine-ubuntu-22.04-amd64.deb \
    || fail 65 "could not download Sunshine"
  $APT install /tmp/sunshine.deb || fail 65 "Sunshine install failed"
  GUID=$(id -u gamer)
  mkdir -p /home/gamer/.config/sunshine
  cat > /home/gamer/.config/sunshine/sunshine.conf <<'CONF'
# Allow the web admin page from the internet (it is password protected).
origin_web_ui_allowed = wan
encoder = nvenc
capture = x11
CONF
  chown -R gamer:gamer /home/gamer/.config
  cat > /etc/systemd/system/cloudgaming-sunshine.service <<UNIT
[Unit]
Description=Sunshine game streaming server
After=cloudgaming-desktop.service
Requires=cloudgaming-desktop.service
[Service]
User=gamer
Environment=DISPLAY=:0
Environment=XDG_RUNTIME_DIR=/run/user/$GUID
ExecStartPre=/bin/sleep 5
ExecStart=/usr/bin/sunshine
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable cloudgaming-sunshine
  done_step sunshine
fi

# ---- 5. Steam ---------------------------------------------------------------
if ! is_done steam; then
  stage 80 steam "Installing Steam"
  dpkg --add-architecture i386
  add-apt-repository -y multiverse >/dev/null 2>&1 || true
  $APT update
  echo steam steam/question select "I AGREE" | debconf-set-selections
  echo steam steam/license note '' | debconf-set-selections
  $APT install steam-installer || echo "Steam install failed - continuing without it"
  done_step steam
fi

# ---- 6. Sunshine login (every boot, from metadata) ---------------------------
stage 90 credentials "Setting the Sunshine admin login"
if [ -n "$SUN_USER" ] && [ -n "$SUN_PASS" ]; then
  sudo -u gamer HOME=/home/gamer /usr/bin/sunshine --creds "$SUN_USER" "$SUN_PASS" >/dev/null 2>&1 || true
fi
systemctl restart cloudgaming-sunshine || fail 90 "Sunshine did not start"

sleep 8
if systemctl is-active --quiet cloudgaming-sunshine; then
  stage 100 ready "Ready to stream - open Moonlight and add this machine's IP"
else
  fail 95 "Sunshine is not running - check: journalctl -u cloudgaming-sunshine"
fi
`;

import type { SetupStage } from './types';
export type { SetupStage };

/**
 * Find the CLOUDGAMING_STAGE lines in raw serial-console text.
 * Returns them in order; the last one is the current state.
 */
export function parseSetupStages(serialOutput: string): SetupStage[] {
  const stages: SetupStage[] = [];
  const re = /CLOUDGAMING_STAGE (\d+) ([a-z_]+) ([^\r\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(serialOutput)) !== null) {
    stages.push({ percent: Number(m[1]), key: m[2], message: m[3].trim() });
  }
  return stages;
}
