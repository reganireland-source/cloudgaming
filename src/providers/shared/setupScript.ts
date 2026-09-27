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
 *     CLOUDGAMING_STAGE 20 drivers Installing the NVIDIA driver…
 * to the machine's SERIAL CONSOLE (/dev/ttyS0). Every cloud lets you read
 * that through its API (Google getSerialPortOutput, AWS GetConsoleOutput,
 * Azure boot diagnostics, Oracle console history), so each provider's
 * getSetupProgress() can show a progress bar without logging in.
 * A full log is also kept on the machine at /var/log/cloudgaming-setup.log.
 *
 * WHAT IT DOES — MODELLED ON CLOUDYPAD
 * ------------------------------------
 * This follows the approach CloudyPad (github.com/PierreBeucher/cloudypad)
 * has proven on AWS, Azure and Google Cloud, instead of hand-building a
 * desktop on the machine:
 *
 *   1. PREPARE the kernel side: the extra kernel modules cloud kernels leave
 *      out (drm), block the open-source "nouveau" driver, enable NVIDIA
 *      kernel modesetting, and install the exact gcc version the kernel was
 *      built with (the driver compiles a kernel module and fails otherwise).
 *   2. NVIDIA DATACENTER DRIVER from NVIDIA's own installer (a pinned .run
 *      version, registered with DKMS so kernel updates rebuild it), then one
 *      reboot. Datacenter GPUs (T4, L4, A10G, A10) need this driver family.
 *   3. DOCKER + the NVIDIA CONTAINER TOOLKIT, so containers can use the GPU.
 *   4. CloudyPad's SUNSHINE CONTAINER (ghcr.io/pierrebeucher/cloudypad/sunshine):
 *      Xorg with a virtual screen, a desktop, audio, Steam/Heroic/Lutris and
 *      Sunshine, already wired together and tested. It installs NVIDIA
 *      libraries matching the host driver itself. Games and settings live on
 *      the machine's disk under /var/lib/cloudgaming/sunshine.
 *   5. AUTO-STOP (like CloudyPad's): if nobody streams (no Moonlight traffic)
 *      and nothing big downloads for N minutes, the machine shuts itself down
 *      so a forgotten machine stops billing. (Azure keeps billing a VM shut
 *      down from inside; the backend's 5-minute reconcile job deallocates it.)
 *
 * One deliberate difference from CloudyPad: Sunshine's web page (port 47990)
 * accepts connections from the internet (password-protected), because
 * Gints Global Gaming Hubjob pairs Moonlight through that page instead of over SSH.
 * ============================================================================
 */

/** Versions pinned for reproducibility (same as CloudyPad at the time of writing). */
export const NVIDIA_DRIVER_VERSION = '590.48.01';          // datacenter (Tesla) driver branch
export const CLOUDYPAD_SUNSHINE_IMAGE = 'ghcr.io/pierrebeucher/cloudypad/sunshine:0.45.2';

export interface SetupScriptOptions {
  sunshineUsername: string;   // letters/digits only
  sunshinePassword: string;   // base64url characters only
  /**
   * Shut the machine down after this many minutes without streaming or
   * downloads. 0 = never. Default 15 (CloudyPad's default).
   */
  autoStopMinutes?: number;
}

/** Only allow characters that are safe inside single quotes in bash. */
function bashSafe(value: string, what: string, pattern = /^[A-Za-z0-9_.@+=-]+$/): string {
  if (!pattern.test(value)) throw new Error(`Unsafe characters in ${what}`);
  return value;
}

/**
 * Build the setup script for one machine. The Sunshine login is baked in
 * (the script file is readable only by root on the machine).
 */
export function buildSetupScript(opts: SetupScriptOptions): string {
  const user = bashSafe(opts.sunshineUsername, 'Sunshine username');
  const pass = bashSafe(opts.sunshinePassword, 'Sunshine password');
  const passB64 = bashSafe(Buffer.from(pass).toString('base64'), 'Sunshine password', /^[A-Za-z0-9+/=]+$/);
  const minutes = Math.max(0, Math.min(24 * 60, Math.round(Number(opts.autoStopMinutes ?? 15)) || 0));
  return SCRIPT_TEMPLATE
    .split('__SUN_USER__').join(user)
    .split('__SUN_PASS_B64__').join(passB64)
    .split('__AUTOSTOP_MINUTES__').join(String(minutes))
    .split('__DRIVER_VERSION__').join(NVIDIA_DRIVER_VERSION)
    .split('__SUNSHINE_IMAGE__').join(CLOUDYPAD_SUNSHINE_IMAGE);
}

// NOTE for editors: this is a String.raw template, so "${" must never appear
// in the bash below (JavaScript would treat it as an insertion). Use $VAR
// instead of ${VAR}, and awk/sed/cut for string manipulation.
const SCRIPT_TEMPLATE = String.raw`#!/bin/bash
# Gints Global Gaming Hubjob machine setup (modelled on CloudyPad). Runs as root.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
STATE=/var/lib/cloudgaming
SUN_DIR=/var/lib/cloudgaming/sunshine
mkdir -p "$STATE"
SUN_USER='__SUN_USER__'
SUN_PASS_B64='__SUN_PASS_B64__'
AUTOSTOP_MINUTES='__AUTOSTOP_MINUTES__'
DRIVER_VERSION='__DRIVER_VERSION__'
SUNSHINE_IMAGE='__SUNSHINE_IMAGE__'
APT="apt-get -o DPkg::Lock::Timeout=900 -y"

# ---- First run (from the cloud's boot hook): install ourselves as a systemd
# service that runs on every boot, start it, and hand over.
# Google Cloud re-runs its boot hook on EVERY boot, so this block must never
# interrupt a setup that's already running (e.g. mid package install):
#   - same script already installed  -> just make sure the service is started
#   - different script (new login, or a machine restored from a snapshot with
#     an older copy) -> install it and restart the service, unless a run is
#     in progress (then the new copy is used from the next boot).
if [ "$(printenv CG_FROM_UNIT)" != "1" ]; then
  CHANGED=1
  cmp -s "$0" /usr/local/sbin/cloudgaming-setup.sh && CHANGED=0
  install -m 700 "$0" /usr/local/sbin/cloudgaming-setup.sh
  cat > /etc/systemd/system/cloudgaming-setup.service <<'UNIT'
[Unit]
Description=Gints Global Gaming Hubjob machine setup
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
  STATE_NOW=$(systemctl show -p ActiveState --value cloudgaming-setup.service)
  if [ "$CHANGED" = "1" ] && [ "$STATE_NOW" != "activating" ]; then
    systemctl restart --no-block cloudgaming-setup.service
  else
    systemctl start --no-block cloudgaming-setup.service
  fi
  exit 0
fi

exec >> /var/log/cloudgaming-setup.log 2>&1
say() { echo "$1"; echo "$1" > /dev/ttyS0 2>/dev/null || true; echo "$1" > /dev/console 2>/dev/null || true; }
stage() { say "CLOUDGAMING_STAGE $1 $2 $3"; }
fail()  { say "CLOUDGAMING_STAGE $1 failed $2"; exit 1; }
done_step() { touch "$STATE/$1.done"; }
is_done()   { [ -f "$STATE/$1.done" ]; }

stage 5 boot "Machine booted, starting setup"

# ============================================================================
# 1. Prepare the kernel side (once)
# ============================================================================
if ! is_done prepare; then
  stage 10 packages "Updating package lists and installing build tools"
  $APT update || fail 10 "apt-get update failed"
  KVER=$(uname -r)
  $APT install curl ca-certificates gnupg pciutils make dkms iptables "linux-headers-$KVER" \
    || fail 10 "could not install build tools / kernel headers"
  # Cloud kernels ship without some modules (e.g. drm) the NVIDIA driver needs.
  $APT install "linux-modules-extra-$KVER" || say "linux-modules-extra not available for $KVER (usually fine)"
  $APT install nvidia-modprobe || true

  stage 14 kernel "Configuring kernel modules for the GPU"
  printf 'blacklist nouveau\noptions nouveau modeset=0\n' > /etc/modprobe.d/blacklist-nouveau.conf
  modprobe -r nouveau 2>/dev/null || true
  # Kernel modesetting for the NVIDIA driver (needed by the virtual display).
  echo 'options nvidia-drm modeset=1' > /etc/modprobe.d/nvidia.conf
  # uinput lets Sunshine create virtual keyboards / mice / gamepads.
  echo uinput > /etc/modules-load.d/uinput.conf
  modprobe uinput || true

  # The driver compiles a kernel module, which must use the SAME gcc version
  # the kernel was built with. /boot/config-<kernel> records it as e.g.
  # CONFIG_GCC_VERSION=120300 -> gcc 12.
  GCC_RAW=$(grep -E '^CONFIG_GCC_VERSION=' "/boot/config-$KVER" | cut -d= -f2)
  if [ -n "$GCC_RAW" ]; then
    GCC_MAJOR=$(echo "$GCC_RAW" | sed -E 's/[0-9]{4}$//')
    say "Kernel was built with gcc $GCC_MAJOR"
    $APT install "gcc-$GCC_MAJOR" || fail 14 "could not install gcc-$GCC_MAJOR to match the kernel"
    update-alternatives --install /usr/bin/gcc gcc "/usr/bin/gcc-$GCC_MAJOR" 100 || true
    update-alternatives --set gcc "/usr/bin/gcc-$GCC_MAJOR" || true
    update-alternatives --install /usr/bin/cc cc /usr/bin/gcc 100 || true
  fi
  update-initramfs -u || true
  done_step prepare
fi

# ============================================================================
# 2. NVIDIA datacenter driver (once), then reboot
# ============================================================================
CURRENT_DRIVER=$(cat /sys/module/nvidia/version 2>/dev/null || echo none)
if [ "$CURRENT_DRIVER" != "$DRIVER_VERSION" ] && ! is_done driver; then
  stage 20 drivers "Installing NVIDIA driver $DRIVER_VERSION (5-10 minutes)"
  RUN=/tmp/NVIDIA-Linux-x86_64-$DRIVER_VERSION.run
  curl -fSL --retry 3 -o "$RUN" "https://us.download.nvidia.com/tesla/$DRIVER_VERSION/NVIDIA-Linux-x86_64-$DRIVER_VERSION.run" \
    || fail 20 "could not download the NVIDIA driver"
  chmod +x "$RUN"
  "$RUN" --no-questions --ui=none --accept-license --dkms || fail 20 "NVIDIA driver install failed - see /var/log/nvidia-installer.log"
  done_step driver
  stage 30 reboot "Driver installed, rebooting once to load it"
  sleep 2
  reboot
  exit 0
fi

stage 35 gpu "Checking the GPU"
if ! nvidia-smi >/dev/null 2>&1; then
  fail 35 "nvidia-smi can't see the GPU - driver did not load (see /var/log/nvidia-installer.log)"
fi
GPU_NAME=$(nvidia-smi --query-gpu=gpu_name --format=csv,noheader | head -1)
say "GPU: $GPU_NAME, driver $(cat /sys/module/nvidia/version)"

# Some /dev/nvidia* device files aren't created at boot on some clouds (e.g.
# AWS G5); create them now and on every boot (CloudyPad does the same).
cat > /usr/local/bin/nvidia-setup-devices.sh <<'DEV'
#!/bin/bash
nvidia-modprobe -f /proc/driver/nvidia/capabilities/mig/config -f /proc/driver/nvidia/capabilities/mig/monitor || true
[ -e /dev/nvidia-modeset ] || mknod /dev/nvidia-modeset c 195 254 || true
nvidia-smi > /dev/null || true
DEV
chmod 755 /usr/local/bin/nvidia-setup-devices.sh
/usr/local/bin/nvidia-setup-devices.sh

# ============================================================================
# 3. Docker + NVIDIA container toolkit (once)
# ============================================================================
if ! is_done docker; then
  stage 45 docker "Installing Docker"
  if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || fail 45 "could not download the Docker installer"
    sh /tmp/get-docker.sh || fail 45 "Docker install failed"
  fi
  stage 52 toolkit "Installing the NVIDIA container toolkit"
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg \
    || fail 52 "could not fetch the NVIDIA container toolkit key"
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  $APT update || true
  $APT install nvidia-container-toolkit || fail 52 "NVIDIA container toolkit install failed"
  nvidia-ctk runtime configure --runtime=docker || fail 52 "could not enable the NVIDIA runtime in Docker"
  systemctl restart docker
  done_step docker
fi

# ============================================================================
# 4. The Sunshine container (config rewritten every boot, so the current
#    login always applies)
# ============================================================================
stage 60 sunshine "Configuring the Sunshine streaming container"
mkdir -p "$SUN_DIR/data" "$SUN_DIR/conf/xfce4" "$SUN_DIR/conf/heroic" "$SUN_DIR/home" "$SUN_DIR/project"

# GPU PCI address in the form Xorg wants: "bus@domain:device:function" in
# decimal, from nvidia-smi's hexadecimal "0000:00:04.0" (CloudyPad does the same).
RAW_BUS=$(nvidia-smi --query-gpu=gpu_bus_id --format=csv,noheader | head -1 | sed -E 's/^0*([0-9A-Fa-f]{4}:)/\1/')
P_DOMAIN=$(echo "$RAW_BUS" | awk -F'[:.]' '{print $(NF-3)}')
P_BUS=$(echo "$RAW_BUS" | awk -F'[:.]' '{print $(NF-2)}')
P_DEV=$(echo "$RAW_BUS" | awk -F'[:.]' '{print $(NF-1)}')
P_FN=$(echo "$RAW_BUS" | awk -F'[:.]' '{print $NF}')
PCI_ID="$((16#$P_BUS))@$((16#$P_DOMAIN)):$((16#$P_DEV)):$((16#$P_FN))"
HOST_DRIVER=$(cat /sys/module/nvidia/version)
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
# Shared memory for the container: half the RAM, as CloudyPad uses (Steam needs a lot).
SHM_SIZE="$((MEM_MB / 2))m"
say "PCI $PCI_ID, driver $HOST_DRIVER, shm $SHM_SIZE"

# Sunshine settings: CloudyPad's template, except the web page is allowed
# from the internet ("wan") so Moonlight can be paired in the browser.
cat > "$SUN_DIR/project/sunshine.conf.template" <<'CONF'
sunshine_name = $SUNSHINE_SERVER_NAME
origin_web_ui_allowed = wan
min_log_level = info
lan_encryption_mode = 2
wan_encryption_mode = 2
credentials_file = /cloudy/data/sunshine/sunshine_credentials.json
file_state = /cloudy/data/sunshine/sunshine_state.json
pkey = /cloudy/data/sunshine/pkey.pem
cert = /cloudy/data/sunshine/cert.pem
max_bitrate = $CLOUDYPAD_SUNSHINE_MAX_BITRATE
$CLOUDYPAD_SUNSHINE_ADDITIONAL_CONFIG
CONF

# ---- Our base image: CloudyPad's container (Steam, Firefox, Heroic for
# Epic/GOG, Lutris) plus Google Chrome, Discord and a Battle.net launcher.
# Built ON the machine from CloudyPad's image, so there's no registry to
# publish to. APPS_VERSION names the recipe: bump it when the Dockerfile
# below changes, and every machine rebuilds on its next boot.
APPS_VERSION=1
APPS_IMAGE="gggh/sunshine-apps:$APPS_VERSION-$(echo "$SUNSHINE_IMAGE" | awk -F: '{print $NF}')"

cat > "$SUN_DIR/project/docker-compose.yml" <<COMPOSE
services:
  cloudy:
    image: $APPS_IMAGE
    container_name: cloudy
    shm_size: "$SHM_SIZE"
    privileged: true
    restart: unless-stopped
    runtime: nvidia
    devices:
      - /dev/uinput
    device_cgroup_rules:
      - 'c 13:* rmw'
    volumes:
      - /dev/input:/dev/input
      - $SUN_DIR/data:/cloudy/data
      - $SUN_DIR/conf/xfce4:/cloudy/conf/xfce4
      - $SUN_DIR/conf/heroic:/cloudy/conf/heroic
      - $SUN_DIR/home:/home/cloudy
      - $SUN_DIR/project/sunshine.conf.template:/cloudy/conf/sunshine/sunshine.conf.template:ro
    ports:
      - "47984:47984/tcp"
      - "47989:47989/tcp"
      - "47990:47990/tcp"
      - "48010:48010/tcp"
      - "47998:47998/udp"
      - "47999:47999/udp"
      - "48000:48000/udp"
      - "48002:48002/udp"
    environment:
      NVIDIA_ENABLE: "true"
      NVIDIA_DRIVER_VERSION: "$HOST_DRIVER"
      NVIDIA_DRIVER_TYPE: "datacenter"
      NVIDIA_PCI_BUS_ID: "$PCI_ID"
      NVIDIA_DRIVER_CAPABILITIES: "all"
      CLOUDYPAD_SCREEN_MAX_WIDTH: "2560"
      CLOUDYPAD_SCREEN_MAX_HEIGHT: "1600"
      CLOUDYPAD_KEYBOARD_LAYOUT: "us"
      CLOUDYPAD_KEYBOARD_MODEL: "pc105"
      CLOUDYPAD_KEYBOARD_VARIANT: ""
      CLOUDYPAD_KEYBOARD_OPTIONS: ""
      CLOUDYPAD_LOCALE: "en_US.UTF-8"
      SUNSHINE_SERVER_NAME: "Gints Global Gaming Hubjob"
      SUNSHINE_WEB_USERNAME: "$SUN_USER"
      SUNSHINE_WEB_PASSWORD_BASE64: "$SUN_PASS_B64"
      CLOUDYPAD_SUNSHINE_ADDITIONAL_CONFIG: ""
      CLOUDYPAD_SUNSHINE_MAX_BITRATE: ""
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]
COMPOSE

# ---- The Dockerfile that adds Chrome, Discord and Battle.net (image name
# APPS_IMAGE is set with the other container settings above).
cat > "$SUN_DIR/project/Dockerfile" <<DOCKERFILE
FROM $SUNSHINE_IMAGE
# Each app is best-effort: if a download fails, the machine still streams,
# just without that app (the build log says which one was skipped).
# Google Chrome: official .deb (also adds Google's repo for updates).
RUN apt-get update \
 && ( curl -fL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
      && apt-get install -y /tmp/chrome.deb || echo "WARNING: Google Chrome skipped" ) \
 && rm -f /tmp/chrome.deb && apt-get clean && rm -rf /var/lib/apt/lists/*
# Discord: official .tar.gz (its .deb depends on libraries Ubuntu 24.04
# dropped), plus the libraries it needs at runtime.
RUN apt-get update \
 && ( apt-get install -y --no-install-recommends libnss3 libatomic1 libxss1 libnotify4 libgbm1 libasound2t64 libxkbfile1 libsecret-1-0 \
      && curl -fL -o /tmp/discord.tar.gz "https://discord.com/api/download?platform=linux&format=tar.gz" \
      && tar -xzf /tmp/discord.tar.gz -C /opt \
      && ln -sf /opt/Discord/Discord /usr/local/bin/discord \
      && chown root:root /opt/Discord/chrome-sandbox && chmod 4755 /opt/Discord/chrome-sandbox \
      || echo "WARNING: Discord skipped" ) \
 && rm -f /tmp/discord.tar.gz && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY battlenet-start.sh /cloudy/bin/battlenet-start.sh
COPY add-apps.py /tmp/add-apps.py
RUN chmod 755 /cloudy/bin/battlenet-start.sh && python3 /tmp/add-apps.py && rm /tmp/add-apps.py \
 && chown -R cloudy:cloudy /cloudy/bin /cloudy/conf/sunshine
DOCKERFILE

# Battle.net has no Linux version: it runs through Lutris (Wine). First
# launch runs Lutris's Battle.net installer (click through once, a few
# minutes); after that it opens Battle.net directly. Games and the Wine
# prefix live in /home/cloudy/Games, which is kept on the machine's disk.
cat > "$SUN_DIR/project/battlenet-start.sh" <<'BNET'
#!/bin/bash
if lutris --list-games --installed --json 2>/dev/null | grep -Eq '"slug": ?"battlenet"'; then
  exec lutris lutris:rungame/battlenet
else
  exec lutris lutris:battlenet
fi
BNET

# Add Chrome, Discord and Battle.net to the apps Moonlight shows.
cat > "$SUN_DIR/project/add-apps.py" <<'PY'
import json
path = "/cloudy/conf/sunshine/apps.json"
with open(path) as f:
    cfg = json.load(f)
start = {"do": "sh -c \"sunshine-app-startup.sh > /tmp/sunshine-session-start.log 2>&1\""}
def app(name, image, cmd, undo=None):
    prep = dict(start)
    if undo:
        prep["undo"] = undo
    return {"name": name, "image-path": image, "prep-cmd": [prep], "detached": [cmd],
            "exclude-global-prep-cmd": "false", "auto-detach": "true", "wait-all": "true", "exit-timeout": "5", "cmd": ""}
extra = [
    app("Google Chrome", "/opt/google/chrome/product_logo_256.png",
        "sh -c \"google-chrome --start-maximized > /tmp/chrome-start.log 2>&1\""),
    app("Discord", "/opt/Discord/discord.png",
        "sh -c \"discord > /tmp/discord-start.log 2>&1\""),
    app("Battle.net", "$(XDG_CONFIG_HOME)/sunshine/assets/lutris.png",
        "sh -c \"battlenet-start.sh > /tmp/battlenet-start.log 2>&1\"",
        undo="sh -c \"lutris-stop.sh > /tmp/lutris-stop.log 2>&1\""),
]
import os
installed = {"Google Chrome": os.path.exists("/usr/bin/google-chrome"), "Discord": os.path.exists("/opt/Discord/Discord"), "Battle.net": True}
extra = [a for a in extra if installed.get(a["name"], True)]
names = {"Google Chrome", "Discord", "Battle.net"}
cfg["apps"] = [a for a in cfg["apps"] if a.get("name") not in names] + extra
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
PY

cd "$SUN_DIR/project" || fail 60 "project directory missing"
if ! docker image inspect "$APPS_IMAGE" >/dev/null 2>&1; then
  if ! docker image inspect "$SUNSHINE_IMAGE" >/dev/null 2>&1; then
    stage 65 download "Downloading the streaming container (several GB, 3-10 minutes)"
    docker pull "$SUNSHINE_IMAGE" || fail 65 "could not download $SUNSHINE_IMAGE"
  fi
  stage 70 apps "Adding Chrome, Discord and Battle.net (2-4 minutes)"
  if ! docker build -t "$APPS_IMAGE" .; then
    # Don't lose the machine over optional apps: stream with CloudyPad's
    # image as-is (Steam, Firefox, Heroic, Lutris) and say so.
    say "WARNING: couldn't add Chrome, Discord and Battle.net - using the standard container"
    APPS_IMAGE="$SUNSHINE_IMAGE"
    sed -i "s#^    image: .*#    image: $APPS_IMAGE#" docker-compose.yml
  fi
fi
stage 75 starting "Starting Sunshine, desktop and Steam"
docker compose up -d --remove-orphans || fail 75 "could not start the Sunshine container"

# First start installs NVIDIA libraries inside the container (a few minutes).
stage 85 warming "Waiting for Sunshine to report healthy (first start takes a few minutes)"
HEALTH=unknown
for i in $(seq 1 120); do
  HEALTH=$(docker inspect -f '{{.State.Health.Status}}' cloudy 2>/dev/null || echo missing)
  [ "$HEALTH" = "healthy" ] && break
  sleep 10
done
if [ "$HEALTH" != "healthy" ]; then
  docker logs --tail 40 cloudy 2>&1 | while read -r line; do say "  container: $line"; done
  fail 85 "Sunshine container is '$HEALTH' after 20 minutes - check: docker logs cloudy"
fi

# ============================================================================
# 5. Auto-stop when idle (CloudyPad-style, dependency-free)
# ============================================================================
if [ "$AUTOSTOP_MINUTES" != "0" ]; then
  # Count Moonlight control packets (UDP 47999) before Docker forwards them.
  iptables -t mangle -C PREROUTING -p udp --dport 47999 -m comment --comment cg-activity -j RETURN 2>/dev/null \
    || iptables -t mangle -I PREROUTING -p udp --dport 47999 -m comment --comment cg-activity -j RETURN
  cat > /usr/local/sbin/cloudgaming-autostop.sh <<AUTOSTOP
#!/bin/bash
# Shut down after $AUTOSTOP_MINUTES minutes with no Moonlight traffic and no
# download above ~10 Mbit/s. Checked every 30 seconds.
LIMIT=\$(( $AUTOSTOP_MINUTES * 60 ))
IDLE=0
IFACE=\$(ip route show default | awk '{print \$5; exit}')
last_pkts=0; last_rx=\$(cat /sys/class/net/\$IFACE/statistics/rx_bytes)
while true; do
  sleep 30
  pkts=\$(iptables -t mangle -L PREROUTING -v -x -n 2>/dev/null | awk '/cg-activity/ {print \$1; exit}')
  pkts=\$(( pkts + 0 ))
  rx=\$(cat /sys/class/net/\$IFACE/statistics/rx_bytes)
  mbps=\$(( (rx - last_rx) * 8 / 30 / 1000000 ))
  if [ "\$pkts" -gt "\$last_pkts" ] || [ "\$mbps" -ge 10 ]; then IDLE=0; else IDLE=\$(( IDLE + 30 )); fi
  last_pkts=\$pkts; last_rx=\$rx
  if [ "\$IDLE" -ge "\$LIMIT" ]; then
    echo "CLOUDGAMING_AUTOSTOP idle for $AUTOSTOP_MINUTES minutes - shutting down" > /dev/ttyS0 2>/dev/null
    shutdown -h now
  fi
done
AUTOSTOP
  chmod 700 /usr/local/sbin/cloudgaming-autostop.sh
  cat > /etc/systemd/system/cloudgaming-autostop.service <<'UNIT'
[Unit]
Description=Gints Global Gaming Hubjob auto-stop when idle
After=docker.service
[Service]
ExecStart=/usr/local/sbin/cloudgaming-autostop.sh
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable cloudgaming-autostop.service
  systemctl restart cloudgaming-autostop.service
  say "Auto-stop enabled: $AUTOSTOP_MINUTES minutes without streaming"
else
  systemctl disable --now cloudgaming-autostop.service 2>/dev/null || true
fi

stage 100 ready "Ready to stream - open Moonlight and add this machine's IP"
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
