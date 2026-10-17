/**
 * src/providers/shared/devTools.ts — OPTIONAL DEVELOPER TOOLS FOR ONE MACHINE
 *
 * A game project's headless tests (Godot), a Windows build smoke test (WINE)
 * and its Python audio/chart tools, installed on a machine you choose — not
 * part of the gaming setup, so other machines stay lean (and AWS's 16 KB
 * user-data limit isn't touched). Served at GET /api/agent/dev-tools.sh; run
 * once on the machine (re-running repairs or updates it):
 *     curl -fsSL <API>/api/agent/dev-tools.sh | sudo bash
 *
 *   user      dev (no password, no sudo) — run tests and keep the checkout here
 *   godot     /usr/local/bin/godot -> /opt/godot/<version>/godot (checksum-verified)
 *   python    /opt/devtools/venv (link a checkout's .venv to it)
 *   wine      64-bit prefix at /home/dev/.wine
 *
 * Nothing private is installed: the project's repo and its licensed assets
 * are copied onto the machine separately, by the developer.
 * Must not contain backticks or "${" (String.raw template).
 */

import crypto from 'crypto';

const DEV_TOOLS_SOURCE = String.raw`#!/bin/bash
# Developer tools for a game project: Godot (headless tests), WINE (Windows
# smoke test), Python audio/chart tools. Ubuntu 22.04/24.04, x86_64.
# Run as root. Safe to run again.
set -euo pipefail
. /etc/os-release
# Another Godot: GODOT_VERSION=4.x.y-stable bash dev-tools.sh
GODOT_VERSION=$(printenv GODOT_VERSION || echo 4.7.2-stable)
DEV_USER=dev
VENV=/opt/devtools/venv
export DEBIAN_FRONTEND=noninteractive
say() { echo "[dev-tools] $*"; }

[ "$(id -u)" = 0 ] || { say "Run it as root: curl -fsSL <url> | sudo bash"; exit 1; }
[ "$(uname -m)" = x86_64 ] || { say "x86_64 machines only."; exit 1; }

# ---- System packages ---------------------------------------------------------
APT="apt-get -y -q -o DPkg::Lock::Timeout=900"
say "Installing system packages (a few minutes)…"
# A machine stopped mid-install leaves dpkg half-done: finish that first.
dpkg --configure -a || true
$APT update || true
# Ubuntu 24.04 renamed libasound2 to libasound2t64.
ASOUND=libasound2
apt-cache show libasound2t64 >/dev/null 2>&1 && ASOUND=libasound2t64
$APT install --no-install-recommends \
  git curl wget unzip xz-utils rsync jq bc build-essential ca-certificates \
  python3 python3-venv python3-pip \
  ffmpeg flac vorbis-tools sox libsndfile1 \
  xvfb xauth x11-utils libx11-6 libxcursor1 libxinerama1 libxrandr2 libxi6 libxkbcommon0 \
  libfontconfig1 libdbus-1-3 libudev1 "$ASOUND" libpulse0 libegl1 libgl1-mesa-dri libglx-mesa0 \
  libvulkan1 vulkan-tools mesa-vulkan-drivers fonts-dejavu \
  winbind cabextract winetricks zstd xclip
# Vulkan: NVIDIA's driver (installed by the gaming setup, with its Vulkan ICD)
# drives the GPU; mesa's lavapipe stays as a software fallback only.

# ---- WINE: WineHQ stable (DXVK/VKD3D-Proton need a recent Wine); Ubuntu's own
# wine64 if WineHQ can't be reached.
if ! dpkg -s winehq-stable >/dev/null 2>&1; then
  say "Installing WineHQ stable…"
  if dpkg --add-architecture i386 \
    && mkdir -pm755 /etc/apt/keyrings \
    && curl -fsSL --retry 3 -o /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key \
    && curl -fsSL --retry 3 -o /etc/apt/sources.list.d/winehq-"$VERSION_CODENAME".sources "https://dl.winehq.org/wine-builds/ubuntu/dists/$VERSION_CODENAME/winehq-$VERSION_CODENAME.sources" \
    && $APT update && $APT install --install-recommends winehq-stable; then
    say "WineHQ $(wine --version 2>/dev/null) installed."
  else
    say "WineHQ unavailable — using Ubuntu's Wine instead."
    rm -f /etc/apt/sources.list.d/winehq-"$VERSION_CODENAME".sources
    $APT update || true
    $APT install --no-install-recommends wine wine64 || say "Wine couldn't be installed — the Windows smoke test won't run."
  fi
fi

# ---- The developer account ---------------------------------------------------
if ! id "$DEV_USER" >/dev/null 2>&1; then
  say "Creating user $DEV_USER…"
  useradd -m -s /bin/bash -p '*' "$DEV_USER"
fi
for g in video render; do if getent group "$g" >/dev/null; then usermod -aG "$g" "$DEV_USER"; fi; done

# ---- Godot -------------------------------------------------------------------
GD=/opt/godot/$GODOT_VERSION
if [ ! -x "$GD/godot" ]; then
  say "Downloading Godot $GODOT_VERSION…"
  T=$(mktemp -d)
  ZIP="Godot_v$GODOT_VERSION"_linux.x86_64.zip
  BASE="https://github.com/godotengine/godot/releases/download/$GODOT_VERSION"
  curl -fsSL --retry 3 -o "$T/$ZIP" "$BASE/$ZIP"
  curl -fsSL --retry 3 -o "$T/SUMS" "$BASE/SHA512-SUMS.txt"
  WANT=$(awk -v f="$ZIP" '$2 == f { print $1 }' "$T/SUMS")
  GOT=$(sha512sum "$T/$ZIP" | cut -d' ' -f1)
  if [ -z "$WANT" ] || [ "$WANT" != "$GOT" ]; then say "Godot download failed its checksum — not installed."; rm -r "$T"; exit 1; fi
  mkdir -p "$GD"
  unzip -q -o "$T/$ZIP" -d "$T/x"
  install -m 755 "$T/x/Godot_v$GODOT_VERSION"_linux.x86_64 "$GD/godot"
  rm -r "$T"
fi
ln -sfn "$GD/godot" /usr/local/bin/godot

# ---- Python tools ------------------------------------------------------------
say "Installing Python packages into $VENV…"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q numpy scipy pillow pypdf librosa soundfile numba scikit-learn imageio imageio-ffmpeg
chmod -R a+rX "$VENV"

# ---- The dev user's shell ----------------------------------------------------
H=$(getent passwd "$DEV_USER" | cut -d: -f6)
if ! grep -q devtools-path "$H/.bashrc" 2>/dev/null; then
  # Before .bashrc's "not interactive? stop" line, so ssh dev@host 'cmd' sees it too.
  { echo "export PATH=$VENV/bin:\$PATH WINEARCH=win64 WINEDEBUG=-all  # devtools-path"; cat "$H/.bashrc" 2>/dev/null; } > "$H/.bashrc.new"
  mv "$H/.bashrc.new" "$H/.bashrc"
  chown "$DEV_USER:" "$H/.bashrc"
fi

# ---- WINE: a 64-bit prefix, without the Mono/Gecko download prompts ----------
if [ ! -f "$H/.wine/system.reg" ]; then
  say "Creating the 64-bit WINE prefix…"
  sudo -u "$DEV_USER" -H env WINEARCH=win64 WINEPREFIX="$H/.wine" WINEDEBUG=-all WINEDLLOVERRIDES="mscoree,mshtml=" \
    xvfb-run -a sh -c 'wineboot -i && wineserver -w' >/dev/null 2>&1 || say "WINE prefix setup reported a problem — run 'wineboot -i' as $DEV_USER to retry."
fi

# ---- DXVK (D3D8-11) + VKD3D-Proton (D3D12) in the prefix: Windows builds render
# with Vulkan on the GPU. Pinned versions, checked against their sha256.
DXVK=2.7.1; DXVK_SHA=d85ce7c79f57ecd765aaa1b9e7007cb875e6fde9f6d331df799bce73d513ce87
VKD3D=3.0.1; VKD3D_SHA=3cf2315522af5e43605ef6d3c41dad91387040bf97199934f3f7ab76caaa2f0c
WINE_MAJOR=$( (wine --version 2>/dev/null || true) | grep -oE '^wine-[0-9]+' | grep -oE '[0-9]+' || true); WINE_MAJOR=$(( 10#0$WINE_MAJOR ))
if [ "$WINE_MAJOR" -lt 9 ]; then
  say "Wine $(wine --version 2>/dev/null) is too old for DXVK $DXVK — skipped (WineHQ stable fixes this)."
elif [ ! -d "$H/.wine/drive_c/windows/system32" ]; then
  say "No WINE prefix — DXVK/VKD3D-Proton skipped."
elif [ "$(cat "$H/.wine/.cg-d3d" 2>/dev/null)" != "dxvk-$DXVK vkd3d-$VKD3D" ]; then
  say "Adding DXVK $DXVK and VKD3D-Proton $VKD3D to the WINE prefix…"
  T=$(mktemp -d)
  curl -fsSL --retry 3 -o "$T/dxvk.tgz" "https://github.com/doitsujin/dxvk/releases/download/v$DXVK/dxvk-$DXVK.tar.gz" || true
  curl -fsSL --retry 3 -o "$T/vkd3d.tzst" "https://github.com/HansKristian-Work/vkd3d-proton/releases/download/v$VKD3D/vkd3d-proton-$VKD3D.tar.zst" || true
  if [ "$(sha256sum < "$T/dxvk.tgz" 2>/dev/null | cut -c1-64)" != "$DXVK_SHA" ] || [ "$(sha256sum < "$T/vkd3d.tzst" 2>/dev/null | cut -c1-64)" != "$VKD3D_SHA" ]; then
    say "DXVK/VKD3D-Proton download failed or didn't match its checksum — skipped (run this script again to retry)."
  else
    tar -xzf "$T/dxvk.tgz" -C "$T"
    tar --zstd -xf "$T/vkd3d.tzst" -C "$T"
    W="$H/.wine/drive_c/windows"
    install -o "$DEV_USER" -m 644 "$T/dxvk-$DXVK"/x64/*.dll "$T/vkd3d-proton-$VKD3D"/x64/*.dll "$W/system32/"
    if [ -d "$W/syswow64" ]; then install -o "$DEV_USER" -m 644 "$T/dxvk-$DXVK"/x32/*.dll "$T/vkd3d-proton-$VKD3D"/x86/*.dll "$W/syswow64/"; fi
    for d in d3d8 d3d9 d3d10core d3d11 dxgi d3d12 d3d12core; do
      sudo -u "$DEV_USER" -H env WINEPREFIX="$H/.wine" WINEDEBUG=-all wine reg add 'HKEY_CURRENT_USER\Software\Wine\DllOverrides' /v "$d" /d native /f >/dev/null 2>&1 || true
    done
    sudo -u "$DEV_USER" -H env WINEPREFIX="$H/.wine" wineserver -w || true
    echo "dxvk-$DXVK vkd3d-$VKD3D" > "$H/.wine/.cg-d3d"
  fi
  rm -r "$T"
fi

# ---- Link an existing checkout's .venv ---------------------------------------
for d in "$H"/*/.git; do
  [ -d "$d" ] || continue
  P=$(dirname "$d")
  [ -e "$P/.venv" ] || { sudo -u "$DEV_USER" ln -s "$VENV" "$P/.venv"; say "Linked $P/.venv -> $VENV"; }
done

mkdir -p /opt/devtools
{
  echo "installed $(date -u +%FT%TZ)"
  echo "user $DEV_USER"
  echo "godot /usr/local/bin/godot $(/usr/local/bin/godot --headless --version 2>/dev/null | tail -1)"
  echo "python $VENV/bin/python $("$VENV/bin/python" --version 2>&1)"
  echo "wine $(wine --version 2>/dev/null || echo missing) $(cat "$H/.wine/.cg-d3d" 2>/dev/null || echo 'no dxvk/vkd3d')"
  echo "gpu $(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null || echo 'none (no NVIDIA driver)')"
  vulkaninfo --summary 2>/dev/null | grep -E '^\s*(deviceName|driverName|driverInfo|apiVersion)' | sed 's/^ */vulkan /' || true
} | tee /opt/devtools/READY
say "Done. Log in as $DEV_USER (sudo -iu $DEV_USER, or ssh $DEV_USER@<machine>)."
`;

/**
 * What the machine gets: the script without its comment lines (it can be
 * inlined into Oracle's 32 KB user data). The sha256 is of exactly this.
 */
export const DEV_TOOLS_SCRIPT = DEV_TOOLS_SOURCE.split('\n').filter((line, i) => i === 0 || !/^\s*#(?!!)/.test(line)).join('\n');

export const DEV_TOOLS_SHA256 = crypto.createHash('sha256').update(DEV_TOOLS_SCRIPT).digest('hex');
