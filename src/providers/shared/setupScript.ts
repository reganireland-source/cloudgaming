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
  /**
   * EXPERIMENTAL "big screen": install NVIDIA's GRID (virtual workstation)
   * driver instead of the datacenter one, which lifts the headless screen
   * limit from 2560x1600 to 4096x2160. `gridSource` says whose build and
   * licence to use: AWS and Azure include the licence; Google needs the
   * machine created with a "vWS" GPU (licence billed by Google).
   */
  displayDriver?: 'standard' | 'grid';
  gridSource?: 'aws' | 'azure' | 'gcp';
  /**
   * The machine's nickname, which Sunshine announces (what Moonlight lists).
   * At every boot the machine prefers the CURRENT nickname from the cloud's
   * own metadata (tag / label "cg-nickname", updated when you rename it in
   * the app) and falls back to this one.
   */
  serverName?: string;
}

/** Characters allowed in a nickname (also safe inside quotes in bash and YAML). */
export const NICKNAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

/** Where each cloud publishes its licensed GRID driver (Linux). */
export const GRID_DRIVER = {
  // Listed anonymously; "latest/" holds one NVIDIA-Linux-x86_64-<ver>-grid-aws.run.
  aws: 'https://ec2-linux-nvidia-drivers.s3.amazonaws.com',
  // Microsoft's build for NCasT4_v3 on Ubuntu 22.04 (vGPU 20.2), from its N-series driver docs.
  azure: 'https://download.microsoft.com/download/51239696-ec04-4c02-a6b3-1d9c608fb57c/NVIDIA-Linux-x86_64-595.58.03-grid-azure.run',
  // Google's public bucket. Files download anonymously but the folder list
  // doesn't (401), so the newest is found with the VM's own token when it can
  // be, else this pinned build (vGPU 20.2, Google's install-grid-drivers docs).
  gcp: 'https://storage.googleapis.com/nvidia-drivers-us-public',
  gcpPinned: 'GRID/vGPU20.2/NVIDIA-Linux-x86_64-595.91.07-grid.run',
} as const;

/** Largest virtual screen per driver (NVIDIA's headless cap vs. GRID's 4K head). */
export const SCREEN_MAX = { standard: { w: 2560, h: 1600 }, grid: { w: 4096, h: 2160 } } as const;

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
  return compactScript(SCRIPT_TEMPLATE
    .split('__SUN_NAME__').join(opts.serverName && NICKNAME_RE.test(opts.serverName) ? opts.serverName : 'Cloud Gaming PC')
    .split('__SUN_USER__').join(user)
    .split('__SUN_PASS_B64__').join(passB64)
    .split('__AUTOSTOP_MINUTES__').join(String(minutes))
    .split('__DRIVER_VERSION__').join(NVIDIA_DRIVER_VERSION)
    .split('__DISPLAY_DRIVER__').join(opts.displayDriver === 'grid' ? 'grid' : 'standard')
    .split('__GRID_SOURCE__').join(opts.displayDriver === 'grid' ? (opts.gridSource || 'aws') : 'none')
    .split('__GRID_AWS__').join(GRID_DRIVER.aws)
    .split('__GRID_AZURE__').join(GRID_DRIVER.azure)
    .split('__GRID_GCP_PINNED__').join(GRID_DRIVER.gcpPinned)
    .split('__GRID_GCP__').join(GRID_DRIVER.gcp)
    .split('__SUNSHINE_IMAGE__').join(CLOUDYPAD_SUNSHINE_IMAGE));
}

/**
 * Drop whole-line comments ("# ...", any indent) to keep the script under the
 * clouds' user-data limits (AWS: 16 KB even gzipped; Oracle: 32 KB of
 * metadata). The comments stay here in the source. Kept: the first line and
 * every "#!" shebang (the heredoc'd helper scripts need theirs). Safe because
 * no heredoc or multi-line string in the script has a meaningful "#" line;
 * trailing comments after code are left alone.
 */
export function compactScript(script: string): string {
  return script.split('\n').filter((line, i) => i === 0 || !/^\s*#(?!!)/.test(line)).join('\n');
}

/** EC2's user-data limit, in bytes before base64. */
export const AWS_USER_DATA_LIMIT = 16384;

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
DISPLAY_DRIVER='__DISPLAY_DRIVER__'   # standard | grid (experimental big screen)
GRID_SOURCE='__GRID_SOURCE__'         # aws | azure | gcp | none
GRID_DIR=/var/lib/cloudgaming/grid
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
# To the log, and ONCE to the serial port the app reads. (On Google Cloud
# /dev/console IS the serial port, so writing to both printed every line
# twice; /dev/console is only a fallback when there's no ttyS0.)
say() { echo "$1"; echo "$1" > /dev/ttyS0 2>/dev/null || echo "$1" > /dev/console 2>/dev/null || true; }
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
if [ "$DISPLAY_DRIVER" = "grid" ] && ! is_done driver-grid; then
  # EXPERIMENTAL big screen: NVIDIA's GRID (virtual workstation) driver, in
  # the cloud's own licensed build. Lifts the 2560x1600 headless limit.
  stage 20 drivers "Installing the NVIDIA GRID driver for big screens (experimental, 5-10 minutes)"
  mkdir -p "$GRID_DIR"
  GRID_RUN=$(ls "$GRID_DIR"/NVIDIA-Linux-x86_64-*.run 2>/dev/null | head -1)
  if [ -z "$GRID_RUN" ]; then
    case "$GRID_SOURCE" in
      aws)
        KEY=$(curl -fsS --retry 3 "__GRID_AWS__/?list-type=2&prefix=latest/" | grep -o '<Key>[^<]*grid[^<]*[.]run</Key>' | sed -e 's#<Key>##' -e 's#</Key>##' | head -1)
        GRID_URL="__GRID_AWS__/$KEY"
        [ -n "$KEY" ] || fail 20 "could not find the GRID driver in AWS's driver bucket" ;;
      azure)
        GRID_URL='__GRID_AZURE__' ;;
      gcp)
        # Listing the bucket needs a Google token (anonymous gets 401); the VM's
        # service account usually has storage read. No token: the pinned build.
        TOKEN=$(curl -fsS -H 'Metadata-Flavor: Google' \
          'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' 2>/dev/null \
          | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')
        NAME=""
        if [ -n "$TOKEN" ]; then
          NAME=$(curl -fsS --retry 3 -H "Authorization: Bearer $TOKEN" \
            "https://storage.googleapis.com/storage/v1/b/nvidia-drivers-us-public/o?prefix=GRID/vGPU&maxResults=1000&fields=items(name)" 2>/dev/null \
            | grep -o '"GRID/vGPU[0-9.]*/NVIDIA-Linux-x86_64-[0-9.]*-grid[.]run"' | tr -d '"' | sort -t/ -k2,2V | tail -1)
        fi
        if [ -z "$NAME" ]; then
          NAME='__GRID_GCP_PINNED__'
          say "Google's driver list needs permissions this machine doesn't have; using the known build $NAME"
        fi
        GRID_URL="__GRID_GCP__/$NAME" ;;
      *) fail 20 "big screen isn't available on this cloud" ;;
    esac
    say "GRID driver: $GRID_URL"
    GRID_RUN="$GRID_DIR/$(basename "$GRID_URL")"
    curl -fSL --retry 3 -o "$GRID_RUN.part" "$GRID_URL" && mv "$GRID_RUN.part" "$GRID_RUN" \
      || fail 20 "could not download the GRID driver"
  fi
  chmod +x "$GRID_RUN"
  # GPU pass-through + GRID: the GSP firmware must be off (NVIDIA; AWS for G4dn/G5).
  grep -q NVreg_EnableGpuFirmware /etc/modprobe.d/nvidia.conf 2>/dev/null \
    || echo 'options nvidia NVreg_EnableGpuFirmware=0' >> /etc/modprobe.d/nvidia.conf
  "$GRID_RUN" --no-questions --ui=none --accept-license --dkms || fail 20 "GRID driver install failed - see /var/log/nvidia-installer.log"
  if [ "$GRID_SOURCE" = "azure" ] && [ -f /etc/nvidia/gridd.conf.template ]; then
    # Azure licenses GRID itself; its docs: no FeatureType, IgnoreSP/EnableUI off.
    cp /etc/nvidia/gridd.conf.template /etc/nvidia/gridd.conf
    sed -i '/^FeatureType/d;/^IgnoreSP/d;/^EnableUI/d' /etc/nvidia/gridd.conf
    printf 'IgnoreSP=FALSE\nEnableUI=FALSE\n' >> /etc/nvidia/gridd.conf
  fi
  update-initramfs -u || true
  done_step driver-grid
  stage 30 reboot "GRID driver installed, rebooting once to load it"
  sleep 2
  reboot
  exit 0
fi
if [ "$DISPLAY_DRIVER" != "grid" ] && [ "$CURRENT_DRIVER" != "$DRIVER_VERSION" ] && ! is_done driver; then
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
if [ "$DISPLAY_DRIVER" = "grid" ]; then
  # Unlicensed GRID drivers slow down after ~20 minutes, so say what we see.
  GRID_LICENSE=$(nvidia-smi -q 2>/dev/null | grep -i -m1 'License Status' | sed 's/.*: *//')
  say "GRID driver (big screen, experimental): licence status '$GRID_LICENSE'"
fi

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
# Settings + logins of the apps we add live under XDG_CONFIG_HOME
# (/cloudy/conf) inside the container, which is NOT kept when the container
# is recreated. Keep them on the machine's disk like Steam and the home
# folder, so you log in once per machine. (Owned by the container's user,
# uid 1001.)
KEEP_CONF="google-chrome discord lutris"
for d in $KEEP_CONF; do mkdir -p "$SUN_DIR/conf/$d"; done

# GPU PCI address in the form Xorg wants: "bus@domain:device:function" in
# decimal, from nvidia-smi's hexadecimal "0000:00:04.0" (CloudyPad does the same).
RAW_BUS=$(nvidia-smi --query-gpu=gpu_bus_id --format=csv,noheader | head -1 | sed -E 's/^0*([0-9A-Fa-f]{4}:)/\1/')
P_DOMAIN=$(echo "$RAW_BUS" | awk -F'[:.]' '{print $(NF-3)}')
P_BUS=$(echo "$RAW_BUS" | awk -F'[:.]' '{print $(NF-2)}')
P_DEV=$(echo "$RAW_BUS" | awk -F'[:.]' '{print $(NF-1)}')
P_FN=$(echo "$RAW_BUS" | awk -F'[:.]' '{print $NF}')
PCI_ID="$((16#$P_BUS))@$((16#$P_DOMAIN)):$((16#$P_DEV)):$((16#$P_FN))"
HOST_DRIVER=$(cat /sys/module/nvidia/version)
CONTAINER_DRIVER_TYPE=datacenter; SCREEN_MAX_W=2560; SCREEN_MAX_H=1600
if [ "$DISPLAY_DRIVER" = "grid" ]; then
  # The container installs the driver's user-space part matching the host.
  # CloudyPad only downloads datacenter/display builds, so hand it the GRID
  # installer we already have, under the name and marker it looks for.
  CONTAINER_DRIVER_TYPE=grid; SCREEN_MAX_W=4096; SCREEN_MAX_H=2160
  GRID_RUN=$(ls "$GRID_DIR"/NVIDIA-Linux-x86_64-*.run 2>/dev/null | head -1)
  [ -n "$GRID_RUN" ] || fail 60 "the GRID driver installer is missing from $GRID_DIR"
  mkdir -p "$SUN_DIR/data/nvidia"
  if [ ! -f "$SUN_DIR/data/nvidia/nvidia-driver-grid-$HOST_DRIVER.downloaded" ]; then
    rm -f "$SUN_DIR/data/nvidia/"nvidia-*.run "$SUN_DIR/data/nvidia/"nvidia-driver-*.downloaded
    cp "$GRID_RUN" "$SUN_DIR/data/nvidia/nvidia-grid-$HOST_DRIVER.run"
    chmod 755 "$SUN_DIR/data/nvidia/nvidia-grid-$HOST_DRIVER.run"
    touch "$SUN_DIR/data/nvidia/nvidia-driver-grid-$HOST_DRIVER.downloaded"
  fi
fi
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
APPS_VERSION=7
# UMU (Proton launcher for Lutris) release: github.com/Open-Wine-Components/umu-launcher/releases
UMU_VERSION=1.4.4
# KasmVNC release: github.com/kasmtech/KasmVNC/releases (noble = Ubuntu 24.04)
KASMVNC_VERSION=1.5.0
APPS_IMAGE="gggh/sunshine-apps:$APPS_VERSION-$(echo "$SUNSHINE_IMAGE" | awk -F: '{print $NF}')"

# ---- Browser access (no app to install), both HTTPS with this machine's
# Sunshine login:
#   KASMVNC_PORT  "Use the desktop": KasmVNC mirrors the desktop (runs inside
#                 the Sunshine container, see kasmvnc-start.sh)
#   MLWEB_PORT    "Play in browser" (experimental): Moonlight Web, a Moonlight
#                 client that relays Sunshine's stream to the browser over
#                 WebRTC (UDP MLWEB_UDP); its own container, host network
# One self-signed certificate per machine (kept on the disk); browsers warn
# once, the connection is still encrypted.
KASMVNC_PORT=48200
MLWEB_PORT=48300
MLWEB_UDP=40000:40030
MLWEB_IMAGE=mrcreativ3001/moonlight-web-stream:v2.10.0
mkdir -p "$SUN_DIR/tls" "$SUN_DIR/mlweb/server" "$SUN_DIR/mlweb/tls"
if [ ! -s "$SUN_DIR/tls/cert.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=gints-global-gaming-hubjob" \
    -keyout "$SUN_DIR/tls/key.pem" -out "$SUN_DIR/tls/cert.pem" >/dev/null 2>&1 || say "WARNING: couldn't create the browser-access certificate"
fi
cp "$SUN_DIR/tls/cert.pem" "$SUN_DIR/tls/key.pem" "$SUN_DIR/mlweb/tls/" 2>/dev/null
chown -R 1001:1001 "$SUN_DIR/tls"; chown -R 999:999 "$SUN_DIR/mlweb"   # container users: desktop (1001), Moonlight Web (999)
chmod 600 "$SUN_DIR/tls/key.pem" "$SUN_DIR/mlweb/tls/key.pem" 2>/dev/null
# WebRTC tells the browser where to send video; STUN usually works it out,
# the public IP (it can change after a stop/start) makes it reliable.
PUBLIC_IP=$(curl -fs --max-time 5 https://checkip.amazonaws.com | tr -d '[:space:]' || true)

# The name Sunshine announces (Moonlight lists the machine by it): the current
# nickname from the cloud's metadata service if set (renamed in the app),
# else the one given at launch. Each cloud answers only its own endpoint.
SUN_NAME='__SUN_NAME__'
LIVE_NAME=$(curl -fs --max-time 2 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/cg-nickname 2>/dev/null) \
  || LIVE_NAME=$(IMDS_TOKEN=$(curl -fs --max-time 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token) \
       && curl -fs --max-time 2 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/tags/instance/cg-nickname) \
  || LIVE_NAME=$(curl -fs --max-time 2 -H 'Metadata: true' 'http://169.254.169.254/metadata/instance/compute/tagsList?api-version=2021-02-01' \
       | python3 -c 'import sys,json; print(next((t["value"] for t in json.load(sys.stdin) if t["name"]=="cg-nickname"),""))' 2>/dev/null) \
  || LIVE_NAME=$(curl -fs --max-time 2 -H 'Authorization: Bearer Oracle' http://169.254.169.254/opc/v2/instance/freeformTags \
       | python3 -c 'import sys,json; print(json.load(sys.stdin).get("cg-nickname",""))' 2>/dev/null) \
  || LIVE_NAME=""
LIVE_NAME=$(printf '%s' "$LIVE_NAME" | tr -cd 'A-Za-z0-9 ._-' | cut -c1-40)
[ -n "$LIVE_NAME" ] && SUN_NAME="$LIVE_NAME"
say "Machine name (Moonlight shows this): $SUN_NAME"

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
      - $SUN_DIR/conf/google-chrome:/cloudy/conf/google-chrome
      - $SUN_DIR/conf/discord:/cloudy/conf/discord
      - $SUN_DIR/conf/lutris:/cloudy/conf/lutris
      - $SUN_DIR/home:/home/cloudy
      - $SUN_DIR/project/sunshine.conf.template:/cloudy/conf/sunshine/sunshine.conf.template:ro
      - $SUN_DIR/tls:/cloudy/conf/tls:ro
    ports:
      - "$KASMVNC_PORT:$KASMVNC_PORT/tcp"
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
      NVIDIA_DRIVER_TYPE: "$CONTAINER_DRIVER_TYPE"
      NVIDIA_PCI_BUS_ID: "$PCI_ID"
      NVIDIA_DRIVER_CAPABILITIES: "all"
      CLOUDYPAD_SCREEN_MAX_WIDTH: "$SCREEN_MAX_W"
      CLOUDYPAD_SCREEN_MAX_HEIGHT: "$SCREEN_MAX_H"
      CLOUDYPAD_KEYBOARD_LAYOUT: "us"
      CLOUDYPAD_KEYBOARD_MODEL: "pc105"
      CLOUDYPAD_KEYBOARD_VARIANT: ""
      CLOUDYPAD_KEYBOARD_OPTIONS: ""
      CLOUDYPAD_LOCALE: "en_US.UTF-8"
      SUNSHINE_SERVER_NAME: "$SUN_NAME"
      SUNSHINE_WEB_USERNAME: "$SUN_USER"
      SUNSHINE_WEB_PASSWORD_BASE64: "$SUN_PASS_B64"
      CLOUDYPAD_SUNSHINE_ADDITIONAL_CONFIG: ""
      CLOUDYPAD_SUNSHINE_MAX_BITRATE: ""
      KASMVNC_PORT: "$KASMVNC_PORT"
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]
  mlweb:
    image: $MLWEB_IMAGE
    container_name: mlweb
    network_mode: host
    restart: unless-stopped
    volumes:
      - $SUN_DIR/mlweb/server:/moonlight-web/server
      - $SUN_DIR/mlweb/tls:/tls:ro
    environment:
      BIND_ADDRESS: "0.0.0.0:$MLWEB_PORT"
      SSL_CERTIFICATE: /tls/cert.pem
      SSL_PRIVATE_KEY: /tls/key.pem
      WEBRTC_PORT_RANGE: "$MLWEB_UDP"
$([ -n "$PUBLIC_IP" ] && echo "      WEBRTC_NAT_1TO1_HOST: \"$PUBLIC_IP\"")
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
# UMU launcher: Lutris 0.5.20 runs Proton-based Wine builds (which its
# Battle.net installer picks) only through umu-run, and otherwise stops with
# "Install umu to use Proton". We install UMU's self-contained zipapp (needs
# only python3) from a pinned release by direct link (no API lookup that
# could be rate-limited), on PATH and at /usr/share/umu/umu-run, one of the
# fixed places Lutris checks, so it's found even with a minimal PATH.
# Tested: Lutris 0.5.20's get_umu_path() finds it both ways.
RUN curl -fL --retry 3 -o /tmp/umu.tar "https://github.com/Open-Wine-Components/umu-launcher/releases/download/$UMU_VERSION/umu-launcher-$UMU_VERSION-zipapp.tar" \
 && mkdir -p /tmp/umu-x /usr/share/umu && tar -xf /tmp/umu.tar -C /tmp/umu-x \
 && install -m 755 "\$(find /tmp/umu-x -name umu-run -type f | head -1)" /usr/local/bin/umu-run \
 && ln -sf /usr/local/bin/umu-run /usr/share/umu/umu-run \
 && echo "UMU installed" || echo "WARNING: UMU not installed (Lutris can't use Proton builds)" \
 ; rm -rf /tmp/umu.tar /tmp/umu-x
# KasmVNC ("Use the desktop" in a browser): the server + kasmxproxy, which
# mirrors the existing desktop. Started by the container's supervisord
# (the program is only added if the install worked).
COPY kasmvnc-start.sh /cloudy/bin/kasmvnc-start.sh
COPY kasmvnc.supervisor.conf /tmp/kasmvnc.supervisor.conf
RUN apt-get update \
 && ( curl -fL --retry 3 -o /tmp/kasmvnc.deb "https://github.com/kasmtech/KasmVNC/releases/download/v$KASMVNC_VERSION/kasmvncserver_noble_$KASMVNC_VERSION""_amd64.deb" \
      && apt-get install -y /tmp/kasmvnc.deb x11-utils xauth \
      && chmod 755 /cloudy/bin/kasmvnc-start.sh \
      && cat /tmp/kasmvnc.supervisor.conf >> /cloudy/conf/supervisor/supervisord.conf \
      && echo "KasmVNC installed" || echo "WARNING: KasmVNC skipped (no browser desktop)" ) \
 ; rm -f /tmp/kasmvnc.deb /tmp/kasmvnc.supervisor.conf; apt-get clean; rm -rf /var/lib/apt/lists/*
# "All apps" launcher (Launchpad-style grid). Best-effort.
RUN apt-get update \
 && ( apt-get install -y --no-install-recommends xfdashboard xfdashboard-plugins || apt-get install -y --no-install-recommends xfdashboard \
      || echo "WARNING: xfdashboard skipped (All apps uses the XFCE app finder)" ) \
 ; apt-get clean; rm -rf /var/lib/apt/lists/*
COPY all-apps.sh /cloudy/bin/all-apps.sh
# Battle.net icon for the dock/menu (best-effort; falls back to Lutris's).
RUN curl -fsL -o /usr/share/pixmaps/battlenet.png https://lutris.net/games/icon/battlenet.png || echo "WARNING: Battle.net icon skipped"
COPY battlenet-start.sh /cloudy/bin/battlenet-start.sh
COPY lutris-runtime-update.py /cloudy/bin/lutris-runtime-update.py
COPY lutris-runtime.supervisor.conf /tmp/lutris-runtime.supervisor.conf
RUN chmod 755 /cloudy/bin/lutris-runtime-update.py \
 && cat /tmp/lutris-runtime.supervisor.conf >> /cloudy/conf/supervisor/supervisord.conf && rm /tmp/lutris-runtime.supervisor.conf
COPY add-apps.py /tmp/add-apps.py
RUN chmod 755 /cloudy/bin/battlenet-start.sh /cloudy/bin/all-apps.sh && python3 /tmp/add-apps.py && rm /tmp/add-apps.py \
 && chown -R cloudy:cloudy /cloudy/bin /cloudy/conf/sunshine /cloudy/conf/xfce4-default
DOCKERFILE

# Battle.net has no Linux version: it runs through Lutris (Wine). First
# launch runs Lutris's Battle.net installer (click through once, a few
# minutes); after that it opens Battle.net directly. Games and the Wine
# prefix live in /home/cloudy/Games, which is kept on the machine's disk.
cat > "$SUN_DIR/project/kasmvnc-start.sh" <<'KASMSTART'
#!/bin/bash
# "Use the desktop" in a browser: KasmVNC mirrors the machine's desktop
# (the same X display Sunshine streams) at https://<ip>:KASMVNC_PORT.
# Run by supervisord as the desktop user. Login = the machine's Sunshine
# login (SUNSHINE_WEB_USERNAME / SUNSHINE_WEB_PASSWORD_BASE64).
#   Xkasmvnc  a private display (:10) served over HTTPS/WebSocket
#   kasmxproxy copies DISPLAY (:42) into it and sends keyboard, mouse and
#             clipboard back. :10 is sized to match :42; when :42 changes
#             size (e.g. a Moonlight session picked another resolution),
#             this script exits and supervisord restarts it at the new size.
set -u
PORT="$(printenv KASMVNC_PORT || echo 48200)"
VNC_DISPLAY=:10
TLS_DIR="$(printenv KASMVNC_TLS_DIR || echo /cloudy/conf/tls)"
USER_NAME="$(printenv SUNSHINE_WEB_USERNAME || echo gamer)"
PASS="$(printenv SUNSHINE_WEB_PASSWORD_BASE64 | base64 -d 2>/dev/null)"
[ -n "$PASS" ] || { echo "No login configured; not starting"; sleep 60; exit 1; }

# Wait for the desktop's X server and read its size.
for _ in $(seq 1 120); do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break; sleep 2; done
SIZE="$(xdpyinfo -display "$DISPLAY" 2>/dev/null | awk '/dimensions:/{print $2; exit}')"
[ -n "$SIZE" ] || { echo "Desktop $DISPLAY not available"; exit 1; }

mkdir -p "$HOME/.vnc"
printf '%s\n%s\n' "$PASS" "$PASS" | kasmvncpasswd -u "$USER_NAME" -w "$HOME/.kasmpasswd" >/dev/null
chmod 600 "$HOME/.kasmpasswd"
export XAUTHORITY="$HOME/.Xauthority-kasmvnc"
rm -f "$XAUTHORITY"; touch "$XAUTHORITY"
xauth -f "$XAUTHORITY" add "$VNC_DISPLAY" . "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d " \n")"
rm -f /tmp/.X10-lock /tmp/.X11-unix/X10

Xkasmvnc "$VNC_DISPLAY" -auth "$XAUTHORITY" -geometry "$SIZE" -depth 24 \
  -interface 0.0.0.0 -websocketPort "$PORT" -sslOnly 1 \
  -cert "$TLS_DIR/cert.pem" -key "$TLS_DIR/key.pem" \
  -KasmPasswordFile "$HOME/.kasmpasswd" -httpd /usr/share/kasmvnc/www \
  -FrameRate 30 -MaxVideoResolution 1920x1080 -AcceptSetDesktopSize 0 \
  -SendCutText 1 -AcceptCutText 1 -SendPrimary 0 -DisconnectClients 0 \
  -http-header 'Cross-Origin-Embedder-Policy=require-corp' -http-header 'Cross-Origin-Opener-Policy=same-origin' \
  -SecurityTypes None -PublicIP 127.0.0.1 -rfbport 5910 -Log '*:stdout:30' &
XVNC=$!
for _ in $(seq 1 30); do xdpyinfo -display "$VNC_DISPLAY" >/dev/null 2>&1 && break; sleep 1; done
kasmxproxy -a "$DISPLAY" -v "$VNC_DISPLAY" -f 30 &
PROXY=$!
echo "KasmVNC on port $PORT mirroring $DISPLAY at $SIZE"

# Restart (via supervisord) if anything stops or the desktop changes size.
while kill -0 "$XVNC" 2>/dev/null && kill -0 "$PROXY" 2>/dev/null; do
  sleep 5
  NOW="$(xdpyinfo -display "$DISPLAY" 2>/dev/null | awk '/dimensions:/{print $2; exit}')"
  [ -n "$NOW" ] && [ "$NOW" != "$SIZE" ] && { echo "Desktop size $SIZE -> $NOW, restarting"; break; }
done
kill "$PROXY" "$XVNC" 2>/dev/null; wait
exit 1
KASMSTART
cat > "$SUN_DIR/project/kasmvnc.supervisor.conf" <<'SUPV'

[program:kasmvnc]
priority=60
autostart=true
autorestart=true
startsecs=10
startretries=1000
user=%(ENV_CLOUDYPAD_USER)s
command=/cloudy/bin/kasmvnc-start.sh
environment=HOME="%(ENV_CLOUDYPAD_USER_HOME)s",DISPLAY="%(ENV_DISPLAY)s"
stdout_logfile=%(ENV_CLOUDYPAD_LOG_DIR)s/kasmvnc.log
stderr_logfile=%(ENV_CLOUDYPAD_LOG_DIR)s/kasmvnc.err.log
SUPV
cat > /usr/local/sbin/cloudgaming-mlweb-pair.py <<'MLPAIR'
#!/usr/bin/env python3
"""Pair the browser client (moonlight-web-stream) with this machine's Sunshine.

Runs on the machine after both containers are up, on every boot; it does
nothing if already paired. Steps, all on 127.0.0.1:
  1. sign in to Moonlight Web with the machine's login (the first sign-in
     creates that user as its admin);
  2. add Sunshine (127.0.0.1:47989) as a host, unless it's there;
  3. start pairing: Moonlight Web answers with a PIN (first line of a
     streamed JSON response), which we hand to Sunshine's /api/pin with the
     same login - no one has to type it; then read the result.
Usage: MLWEB_PASSWORD=... mlweb-pair.py <moonlight-web port> <username>
"""
import http.cookiejar, json, os, ssl, sys, time, urllib.request, base64

port, user = sys.argv[1], sys.argv[2]
password = os.environ["MLWEB_PASSWORD"]
WEB = "https://127.0.0.1:%s/api" % port
SUNSHINE_PIN = "https://127.0.0.1:47990/api/pin"
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE  # both use self-signed certificates on this machine
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx), urllib.request.HTTPCookieProcessor(jar))


def call(method, path, body=None, timeout=20):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(WEB + path, data=data, method=method, headers={"Content-Type": "application/json"})
    return opener.open(req, timeout=timeout)


def log(msg):
    print("mlweb-pair: " + msg, flush=True)


def sunshine(method, body=None):
    auth = base64.b64encode(("%s:%s" % (user, password)).encode()).decode()
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(SUNSHINE_PIN, data=data, method=method,
                                 headers={"Content-Type": "application/json", "Authorization": "Basic " + auth})
    with urllib.request.urlopen(req, context=ctx, timeout=10) as r:
        return json.loads(r.read() or b"{}")


def send_pin(pin):
    body = {"pin": pin, "name": "Browser (Moonlight Web)"}
    # Newer Sunshine lists waiting pairing requests (GET /api/pin) and wants
    # the request's id with the PIN; older versions have no such list.
    try:
        pending = sunshine("GET").get("pairings")
    except Exception:
        pending = None
    if pending is not None:
        if not pending:
            return False  # our request hasn't reached Sunshine yet
        mine = [p for p in pending if str(p.get("address", "")).endswith("127.0.0.1")] or pending
        body["pairing_id"] = mine[-1]["id"]
    return sunshine("POST", body).get("status") in (True, "true")


# 1. Wait for Moonlight Web, then sign in.
for attempt in range(60):
    try:
        call("POST", "/login", {"name": user, "password": password}).read()
        break
    except Exception as e:  # not up yet
        if attempt == 59:
            log("Moonlight Web didn't answer: %s" % e); sys.exit(1)
        time.sleep(5)

# 2. Sunshine as a host (wait for it too: it starts after the desktop).
host_id = None
for attempt in range(60):
    try:
        # Streamed: first line = the list, later lines = live updates.
        hosts = json.loads(call("GET", "/hosts").readline()).get("hosts", [])
        if hosts:
            h = hosts[0]
            host_id = h["host_id"]
            if h.get("paired") == "Paired":
                log("already paired"); sys.exit(0)
        else:
            host_id = json.loads(call("POST", "/host", {"address": "127.0.0.1", "http_port": 47989}).readline())["host"]["host_id"]
            log("added Sunshine as host %s" % host_id)
        break
    except Exception as e:
        if attempt == 59:
            log("couldn't add Sunshine: %s" % e); sys.exit(1)
        time.sleep(5)

# 3. Pair: read the PIN, give it to Sunshine, read the outcome.
for attempt in range(5):
    try:
        resp = call("POST", "/pair", {"host_id": host_id}, timeout=120)
        first = json.loads(resp.readline())
        pin = first.get("Pin") if isinstance(first, dict) else None
        if not pin:
            raise RuntimeError("no PIN: %s" % first)
        ok = False
        for _ in range(20):  # Sunshine accepts the PIN once the pairing request has reached it
            time.sleep(1)
            try:
                if send_pin(pin):
                    ok = True; break
            except Exception:
                pass
        second = resp.readline()
        result = json.loads(second) if second.strip() else None
        if isinstance(result, dict) and "Paired" in result:
            log("paired with Sunshine"); sys.exit(0)
        log("pairing attempt %d failed (PIN accepted: %s, result: %s)" % (attempt + 1, ok, result))
    except Exception as e:
        log("pairing attempt %d error: %s" % (attempt + 1, e))
    time.sleep(10)
sys.exit(1)
MLPAIR
chmod 700 /usr/local/sbin/cloudgaming-mlweb-pair.py

cat > "$SUN_DIR/project/battlenet-start.sh" <<'BNET'
#!/bin/bash
# Same preparation as CloudyPad's lutris-start.sh: wait for the desktop's
# X server and join its D-Bus session, or Lutris can't open a window.
wait-x-availability.sh
source export-dbus-address.sh
LUTRIS=/usr/games/lutris
# Is Battle.net installed? Read Lutris's own game database (pga.db, kept on
# the disk) rather than asking Lutris: when a Lutris window is already open,
# "lutris --list-games" hands the question to that copy and prints nothing
# here, which made every click start the installer again.
SLUG=$(python3 - <<'PY'
import os, sqlite3
home = os.path.expanduser("~")
dbs = [os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local/share"), "lutris", "pga.db"),
       os.path.join(home, ".local/share/lutris/pga.db"), "/cloudy/data/lutris/pga.db"]
for db in dbs:
    if not os.path.exists(db):
        continue
    try:
        row = sqlite3.connect(db).execute(
            "SELECT slug FROM games WHERE installed = 1 AND (slug LIKE 'battlenet%' OR slug LIKE 'battle-net%' OR name LIKE 'Battle.net%') "
            "ORDER BY lastplayed DESC").fetchone()
    except Exception:
        row = None
    if row:
        print(row[0])
        break
PY
)
if [ -n "$SLUG" ]; then
  exec "$LUTRIS" "lutris:rungame/$SLUG"
else
  # Lutris only downloads its components (DXVK, VKD3D...) when its main
  # window opens; going straight to the installer skips that and the
  # install stops with "The 'DXVK' runtime component is not installed".
  # Fetch them first (usually already done at container start).
  command -v notify-send >/dev/null && notify-send "Battle.net" "Preparing Lutris components (first time only, 1-2 minutes)..." 2>/dev/null
  flock /tmp/lutris-runtime.lock python3 /cloudy/bin/lutris-runtime-update.py
  exec "$LUTRIS" lutris:battlenet
fi
BNET

# "All apps": a full-screen grid of every installed app with type-to-search,
# like the macOS Launchpad (xfdashboard); XFCE's app finder if it's missing.
cat > "$SUN_DIR/project/all-apps.sh" <<'ALLAPPS'
#!/bin/bash
if command -v xfdashboard >/dev/null 2>&1; then
  xfdashboard --view=builtin.applications 2>/dev/null || exec xfdashboard
else
  exec xfce4-appfinder
fi
ALLAPPS

# Lutris's components (DXVK, VKD3D, ...) live in the home folder, which is
# kept on the disk, so they're fetched at run time rather than baked into
# the image: at every container start (quick when up to date) and before
# the first Battle.net install. Uses Lutris's own updater, headless.
cat > "$SUN_DIR/project/lutris-runtime-update.py" <<'LRT'
#!/usr/bin/env python3
import sys
sys.path.insert(0, "/usr/lib/python3/dist-packages")
from lutris.runtime import RuntimeUpdater
updater = RuntimeUpdater(force=True)
components = updater.create_component_updaters()
print("Lutris components to fetch:", [getattr(c, "name", str(c)) for c in components], flush=True)
for c in components:
    try:
        c.install_update(updater)
        c.join()
        print("fetched", getattr(c, "name", c), flush=True)
    except Exception as e:  # keep going: one failed component shouldn't block the rest
        print("failed", getattr(c, "name", c), e, flush=True)
LRT
cat > "$SUN_DIR/project/lutris-runtime.supervisor.conf" <<'SUPV'

[program:lutris-runtime]
priority=70
autostart=true
autorestart=false
startsecs=0
user=%(ENV_CLOUDYPAD_USER)s
command=flock /tmp/lutris-runtime.lock python3 /cloudy/bin/lutris-runtime-update.py
environment=HOME="%(ENV_CLOUDYPAD_USER_HOME)s",XDG_DATA_HOME="%(ENV_XDG_DATA_HOME)s",XDG_CONFIG_HOME="%(ENV_XDG_CONFIG_HOME)s",XDG_CACHE_HOME="%(ENV_XDG_CACHE_HOME)s"
stdout_logfile=%(ENV_CLOUDYPAD_LOG_DIR)s/lutris-runtime.log
stderr_logfile=%(ENV_CLOUDYPAD_LOG_DIR)s/lutris-runtime.err.log
SUPV

# Add Chrome, Discord and Battle.net to the apps Moonlight shows, to the
# desktop's dock (next to Lutris) and to the app menu. Runs once, while
# the image is built.
cat > "$SUN_DIR/project/add-apps.py" <<'PY'
import json, os
BNET_ICON = "/usr/share/pixmaps/battlenet.png" if os.path.exists("/usr/share/pixmaps/battlenet.png") else "/usr/share/icons/hicolor/128x128/apps/net.lutris.Lutris.png"
installed = {
    "Google Chrome": os.path.exists("/usr/bin/google-chrome"),
    "Discord": os.path.exists("/opt/Discord/Discord"),
    "Battle.net": True,
    "All apps": True,
}
ALL_APPS_ICON = "org.xfce.xfdashboard" if os.path.exists("/usr/share/icons/hicolor/scalable/apps/org.xfce.xfdashboard.svg") else "system-search"

# ---- 1. Moonlight's app list (Sunshine apps.json)
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
    app("Battle.net", BNET_ICON,
        "sh -c \"battlenet-start.sh > /tmp/battlenet-start.log 2>&1\"",
        undo="sh -c \"lutris-stop.sh > /tmp/lutris-stop.log 2>&1\""),
]
extra = [a for a in extra if installed[a["name"]]]
names = set(installed)
cfg["apps"] = [a for a in cfg["apps"] if a.get("name") not in names] + extra
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)

# ---- 2. Desktop entries (app menu) and dock launchers
entries = {
    # plugin id: (name, desktop file name, Exec, Icon, categories)
    19: ("All apps", "all-apps.desktop", "all-apps.sh", ALL_APPS_ICON, "Utility;"),
    20: ("Battle.net", "battlenet.desktop", "battlenet-start.sh", BNET_ICON, "Game;"),
    21: ("Discord", "discord.desktop", "discord", "/opt/Discord/discord.png", "Network;InstantMessaging;"),
    22: ("Google Chrome", "google-chrome.desktop", "google-chrome", "google-chrome", "Network;WebBrowser;"),
}
entries = {pid: e for pid, e in entries.items() if installed[e[0]]}
DEFAULT = "/cloudy/conf/xfce4-default"
for pid, (name, fname, exe, icon, cats) in entries.items():
    body = ("[Desktop Entry]\nName=%s\nExec=%s\nIcon=%s\nTerminal=false\nType=Application\nCategories=%s\nStartupNotify=false\n"
            % (name, exe, icon, cats))
    if fname != "google-chrome.desktop":          # Chrome's package installs its own menu entry
        with open("/usr/share/applications/" + fname, "w") as f:
            f.write(body)
    d = "%s/panel/launcher-%d" % (DEFAULT, pid)
    os.makedirs(d, exist_ok=True)
    with open(d + "/" + fname, "w") as f:
        f.write(body)

# xfdashboard: open on the grid of ALL apps (not the window overview or
# menu folders) every time, with the search box cleared.
os.makedirs(DEFAULT + "/xfconf/xfce-perchannel-xml", exist_ok=True)
with open(DEFAULT + "/xfconf/xfce-perchannel-xml/xfdashboard.xml", "w") as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n<channel name="xfdashboard" version="1.0">\n'
            '  <property name="switch-to-view-on-resume" type="string" value="builtin.applications"/>\n'
            '  <property name="reset-search-on-resume" type="bool" value="true"/>\n'
            '  <property name="components" type="empty">\n'
            '    <property name="applications-view" type="empty">\n'
            '      <property name="show-all-apps" type="bool" value="true"/>\n'
            '    </property>\n  </property>\n</channel>\n')

panel = DEFAULT + "/xfconf/xfce-perchannel-xml/xfce4-panel.xml"
with open(panel) as f:
    xml = f.read()
anchor_ids = '<value type="int" value="12"/>'                    # Lutris, in the dock order
anchor_plugins = '<property name="plugin-98" type="string" value="separator"/>'
if entries and anchor_ids in xml and anchor_plugins in xml and 'name="plugin-19"' not in xml and 'name="plugin-20"' not in xml:
    ids = "".join('\n        <value type="int" value="%d"/>' % pid for pid in entries)
    xml = xml.replace(anchor_ids, anchor_ids + ids, 1)
    plugins = "".join(
        '<property name="plugin-%d" type="string" value="launcher">\n'
        '      <property name="items" type="array">\n'
        '        <value type="string" value="%s"/>\n'
        '      </property>\n'
        '    </property>\n    ' % (pid, e[1]) for pid, e in entries.items())
    xml = xml.replace(anchor_plugins, plugins + anchor_plugins, 1)
    with open(panel, "w") as f:
        f.write(xml)
    print("Dock: added " + ", ".join(e[0] for e in entries.values()))
elif 'name="plugin-19"' in xml or 'name="plugin-20"' in xml:
    print("Dock: launchers already present")
else:
    print("WARNING: dock layout not recognised - apps are still in Moonlight and the app menu")
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
  # Say whether Lutris will find UMU (needed for Proton builds, e.g. Battle.net).
  UMU_CHECK=$(docker run --rm --entrypoint sh "$APPS_IMAGE" -c 'command -v umu-run || ls /usr/share/umu/umu-run 2>/dev/null || echo MISSING' 2>/dev/null | tail -1)
  say "UMU for Lutris/Proton: $UMU_CHECK"
fi
# Machines set up before these folders were kept: copy any existing
# settings out of the old container once, so nobody gets logged out.
for d in $KEEP_CONF; do
  if [ -z "$(ls -A "$SUN_DIR/conf/$d" 2>/dev/null)" ] && docker container inspect cloudy >/dev/null 2>&1; then
    docker cp "cloudy:/cloudy/conf/$d/." "$SUN_DIR/conf/$d/" >/dev/null 2>&1 && say "Kept existing $d settings"
  fi
done
chown -R 1001:1001 $(for d in $KEEP_CONF; do echo "$SUN_DIR/conf/$d"; done)

stage 75 starting "Starting Sunshine, desktop and Steam"
SERVICES=""
if ! docker image inspect "$MLWEB_IMAGE" >/dev/null 2>&1 && ! docker pull -q "$MLWEB_IMAGE" >/dev/null 2>&1; then
  say "WARNING: couldn't download Moonlight Web - browser play unavailable this boot"
  SERVICES="cloudy"
fi
docker compose up -d --remove-orphans $SERVICES || fail 75 "could not start the Sunshine container"

# First start installs NVIDIA libraries inside the container (a few minutes).
stage 85 warming "Waiting for Sunshine to report healthy (first start takes a few minutes)"
HEALTH=unknown
for i in $(seq 1 120); do
  HEALTH=$(docker inspect -f '{{.State.Health.Status}}' cloudy 2>/dev/null || echo missing)
  [ "$HEALTH" = "healthy" ] && break
  # Every minute, show what the container is doing (its newest log line) in
  # the app's progress panel, so a slow or stuck start isn't a black box.
  if [ $((i % 6)) -eq 0 ]; then
    LAST=$(docker logs --tail 40 cloudy 2>&1 | tr -d '\r' | grep -v -i -E 'pass|secret|token|credential' | grep -v -E '^[[:space:]]*$' | tail -1 | cut -c1-160)
    say "CLOUDGAMING_DETAIL $((i / 6)) min, container $HEALTH: $LAST"
  fi
  sleep 10
done
if [ "$HEALTH" != "healthy" ]; then
  docker logs --tail 40 cloudy 2>&1 | while read -r line; do say "  container: $line"; done
  LASTERR=$(docker logs --tail 200 cloudy 2>&1 | tr -d '\r' | grep -i -E 'error|fail|fatal|cannot|unable' | grep -v -i -E 'pass|secret|token|credential' | tail -1 | cut -c1-160)
  fail 85 "Sunshine container is '$HEALTH' after 20 minutes. Last error: $LASTERR (full log: docker logs cloudy)"
fi

# Browser play: pair Moonlight Web with Sunshine (no-op once paired).
if docker container inspect mlweb >/dev/null 2>&1; then
  ( MLWEB_PASSWORD="$(printf '%s' "$SUN_PASS_B64" | base64 -d)" python3 /usr/local/sbin/cloudgaming-mlweb-pair.py "$MLWEB_PORT" "$SUN_USER" 2>&1 \
      | while read -r line; do say "$line"; done ) &
fi

# ============================================================================
# 5. Auto-stop when idle (CloudyPad-style, dependency-free)
# ============================================================================
if [ "$AUTOSTOP_MINUTES" != "0" ]; then
  # Count Moonlight control packets (UDP 47999) before Docker forwards them.
  # Browser sessions count too: KasmVNC and Moonlight Web (TCP), WebRTC (UDP).
  for R in "-p udp --dport 47999" "-p tcp --dport $KASMVNC_PORT" "-p tcp --dport $MLWEB_PORT" "-p udp --dport $MLWEB_UDP"; do
    iptables -t mangle -C PREROUTING $R -m comment --comment cg-activity -j RETURN 2>/dev/null \
      || iptables -t mangle -I PREROUTING $R -m comment --comment cg-activity -j RETURN
  done
  cat > /usr/local/sbin/cloudgaming-autostop.sh <<AUTOSTOP
#!/bin/bash
# Shut down after $AUTOSTOP_MINUTES minutes with no Moonlight or browser traffic and no
# download above ~10 Mbit/s. Checked every 30 seconds.
LIMIT=\$(( $AUTOSTOP_MINUTES * 60 ))
IDLE=0
IFACE=\$(ip route show default | awk '{print \$5; exit}')
last_pkts=0; last_rx=\$(cat /sys/class/net/\$IFACE/statistics/rx_bytes)
while true; do
  sleep 30
  pkts=\$(iptables -t mangle -L PREROUTING -v -x -n 2>/dev/null | awk '/cg-activity/ {s+=\$1} END {print s+0}')
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
  // "CLOUDGAMING_DETAIL <text>" is a live sub-status for the stage before it
  // (e.g. the container's newest log line while waiting); the latest wins.
  const re = /CLOUDGAMING_(?:STAGE (\d+) ([a-z_]+)|DETAIL) ([^\r\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(serialOutput)) !== null) {
    if (m[1] === undefined) {
      const last = stages[stages.length - 1];
      if (last) last.detail = m[3].trim();
      continue;
    }
    const stage: SetupStage = { percent: Number(m[1]), key: m[2], message: m[3].trim() };
    // Skip a line identical to the one just before it: older setup scripts
    // printed every line twice on Google Cloud. (A real repeat, such as
    // "Machine booted" after the driver reboot, has other lines in between.)
    const prev = stages[stages.length - 1];
    if (prev && prev.percent === stage.percent && prev.key === stage.key && prev.message === stage.message) continue;
    stages.push(stage);
  }
  return stages;
}
