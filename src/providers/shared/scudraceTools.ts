/**
 * src/providers/shared/scudraceTools.ts: OPTIONAL "SCUD RACE REVISITED" DEVELOPER PROFILE
 *
 * Everything the Scud Race Revisited project does on a Linux machine EXCEPT the
 * Unity builds: git + git-lfs + GitHub CLI, a Python 3.11+ environment for its
 * analysis / remaster tools, Blender headless (model ingest and thumbnails),
 * Node 20 with glTF tools, headless Chromium (Playwright), ffmpeg/ImageMagick,
 * and optionally Ghidra. Served at GET /api/agent/scudrace-tools.sh and run once
 * on a machine you choose (re-running repairs or updates it):
 *     curl -fsSL <API>/api/agent/scudrace-tools.sh | sudo bash
 * Optional extras (environment variables, passed through sudo):
 *     curl -fsSL <API>/api/agent/scudrace-tools.sh | sudo INSTALL_TORCH=1 INSTALL_GHIDRA=1 bash
 *
 * It is NOT part of any machine's gaming setup (other machines stay lean and
 * AWS's 16 KB user-data limit isn't touched). Nothing private or secret is in
 * it: the repository, the GitHub token (GH_TOKEN / GITHUB_TOKEN), the Gemini key
 * (~/.scudrace_gemini_key) and the leaderboard group code
 * (~/.scudrace_leaderboard_group) are placed on the machine by the user.
 * Must not contain backticks or "${" (String.raw template).
 */

import crypto from 'crypto';

export const SCUDRACE_TOOLS_SCRIPT = String.raw`#!/bin/bash
# "Scud Race Revisited" developer tools. Ubuntu 22.04/24.04, x86_64. Run as root.
# Safe to run again. Everything except the Unity builds.
#   curl -fsSL <API>/api/agent/scudrace-tools.sh | sudo bash
# Extras: INSTALL_TORCH=1 (CPU PyTorch for texture upscaling), INSTALL_GHIDRA=1
# (Ghidra + OpenJDK 17), BLENDER_VERSION=4.2.3, GHIDRA_URL=<zip>.
set -euo pipefail
. /etc/os-release
BLENDER_VERSION=$(printenv BLENDER_VERSION || echo 4.2.3)
INSTALL_TORCH=$(printenv INSTALL_TORCH || echo 0)
INSTALL_GHIDRA=$(printenv INSTALL_GHIDRA || echo 0)
GHIDRA_URL=$(printenv GHIDRA_URL || echo https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_11.2.1_build/ghidra_11.2.1_PUBLIC_20241105.zip)
DEV_USER=dev
VENV=/opt/scudrace/venv
export DEBIAN_FRONTEND=noninteractive
say() { echo "[scudrace-tools] $*"; }
FAILED=""
note_fail() { FAILED="$FAILED $1"; say "PROBLEM: $1"; }

[ "$(id -u)" = 0 ] || { say "Run it as root: curl -fsSL <url> | sudo bash"; exit 1; }
[ "$(uname -m)" = x86_64 ] || { say "x86_64 machines only."; exit 1; }

# ---- What this machine has (the project wants 4+ cores, 16 GB RAM, 100 GB disk) ----
CORES=$(nproc)
MEM_GB=$(awk '/MemTotal/ { printf "%d", $2 / 1048576 }' /proc/meminfo)
DISK_GB=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
say "This machine: $CORES cores, about $MEM_GB GB RAM, $DISK_GB GB free on /."
[ "$CORES" -ge 4 ] || say "Warning: fewer than 4 cores; the analysis tools will be slow."
[ "$MEM_GB" -ge 15 ] || say "Warning: less than 16 GB RAM; large model jobs may run out of memory."
[ "$DISK_GB" -ge 60 ] || say "Warning: under 60 GB free; the repo's LFS set and analysis outputs are large. Add disk before cloning."

APT="apt-get -y -q -o DPkg::Lock::Timeout=900"
say "Installing system packages (a few minutes)..."
dpkg --configure -a || true
$APT update || true
# Ubuntu 24.04 renamed some library packages with a t64 suffix.
pick() { for p in "$@"; do if apt-cache show "$p" >/dev/null 2>&1; then echo "$p"; return; fi; done; echo "$1"; }
GLIB=$(pick libglib2.0-0t64 libglib2.0-0)
$APT install --no-install-recommends \
  git git-lfs build-essential cmake unzip zip rsync curl wget jq tar zstd gzip xz-utils bzip2 sqlite3 ca-certificates gnupg \
  software-properties-common pkg-config \
  python3 python3-venv python3-pip python3-dev \
  libsndfile1 libgl1 "$GLIB" libegl1 libopengl0 libxrender1 libxi6 libxkbcommon0 libxfixes3 libxxf86vm1 libxext6 libsm6 libice6 libx11-6 \
  ffmpeg imagemagick fonts-dejavu fonts-liberation \
  xvfb xauth

# ---- git-lfs -------------------------------------------------------------------
git lfs install --system || note_fail "git lfs install"

# ---- GitHub CLI (it uses GH_TOKEN / GITHUB_TOKEN from the environment; nothing is stored here) ----
if ! command -v gh >/dev/null 2>&1; then
  say "Installing the GitHub CLI..."
  mkdir -p -m 755 /etc/apt/keyrings
  if curl -fsSL --retry 3 https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; then
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
    $APT update || true
    $APT install gh || note_fail "gh"
  else
    note_fail "gh (could not download its signing key)"
  fi
fi

# ---- Python 3.11+ (22.04 ships 3.10, so it comes from the deadsnakes PPA there) ----
PY=python3
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
  say "Adding Python 3.11 (this Ubuntu's python3 is older)..."
  if add-apt-repository -y ppa:deadsnakes/ppa && $APT update && $APT install python3.11 python3.11-venv python3.11-dev; then PY=python3.11; else note_fail "python3.11"; fi
fi
say "Python for the project: $($PY --version 2>&1)"

# ---- Node.js 20 LTS + glTF tools ----------------------------------------------------
NODE_MAJOR=$( (node -v 2>/dev/null || echo v0) | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" != 20 ]; then
  say "Installing Node.js 20..."
  if curl -fsSL --retry 3 https://deb.nodesource.com/setup_20.x | bash - && $APT install nodejs; then :; else note_fail "nodejs 20"; fi
fi
if command -v npm >/dev/null 2>&1; then
  say "Installing glTF tools (gltf-transform, gltfpack) and Playwright..."
  npm install -g @gltf-transform/cli gltfpack playwright >/dev/null 2>&1 || note_fail "npm global packages (gltf-transform, gltfpack, playwright)"
  mkdir -p /opt/playwright
  PLAYWRIGHT_BROWSERS_PATH=/opt/playwright playwright install --with-deps chromium >/dev/null 2>&1 || note_fail "playwright chromium"
  chmod -R a+rX /opt/playwright 2>/dev/null || true
  printf 'export PLAYWRIGHT_BROWSERS_PATH=/opt/playwright\n' > /etc/profile.d/scudrace-playwright.sh
fi

# ---- Blender (headless): the official tarball, checked against Blender's own checksum ----
BLEND_DIR=/opt/blender-$BLENDER_VERSION
if [ ! -x "$BLEND_DIR/blender" ]; then
  MAJMIN=$(echo "$BLENDER_VERSION" | cut -d. -f1,2)
  BASE=https://download.blender.org/release/Blender$MAJMIN
  TAR=blender-$BLENDER_VERSION-linux-x64.tar.xz
  say "Downloading Blender $BLENDER_VERSION..."
  T=$(mktemp -d)
  if curl -fsSL --retry 3 -o "$T/$TAR" "$BASE/$TAR" && curl -fsSL --retry 3 -o "$T/SUM" "$BASE/blender-$BLENDER_VERSION.sha256"; then
    WANT=$(awk -v f="$TAR" '$2 == f { print $1 }' "$T/SUM")
    GOT=$(sha256sum "$T/$TAR" | cut -d' ' -f1)
    if [ -n "$WANT" ] && [ "$WANT" = "$GOT" ]; then
      mkdir -p "$BLEND_DIR"
      tar -xJf "$T/$TAR" -C "$BLEND_DIR" --strip-components=1
    else
      note_fail "blender (download failed its checksum)"
    fi
  else
    note_fail "blender (could not download $BLENDER_VERSION)"
  fi
  rm -r "$T"
fi
[ -x "$BLEND_DIR/blender" ] && ln -sfn "$BLEND_DIR/blender" /usr/local/bin/blender

# ---- Python environment (analysis, models, textures, audio, ROM tools) ----------------
say "Installing Python packages into $VENV (several minutes)..."
mkdir -p /opt/scudrace
[ -x "$VENV/bin/python" ] || $PY -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip wheel setuptools
PKGS="numpy scipy scikit-image pillow imageio imageio-ffmpeg matplotlib shapely networkx trimesh mapbox_earcut fast_simplification xatlas fonttools soundfile tifffile capstone z80dis requests opencv-python-headless pytest"
if ! "$VENV/bin/pip" install -q $PKGS; then
  say "Some packages failed together; trying them one by one..."
  for p in $PKGS; do "$VENV/bin/pip" install -q "$p" || note_fail "pip $p"; done
fi
if [ "$INSTALL_TORCH" = 1 ]; then
  say "Installing PyTorch (CPU build)..."
  "$VENV/bin/pip" install -q torch --index-url https://download.pytorch.org/whl/cpu || note_fail "torch (cpu)"
fi
chmod -R a+rX /opt/scudrace

# ---- Ghidra 11 + OpenJDK 17, only when asked for (the ROM-derived data is already in the repo) ----
if [ "$INSTALL_GHIDRA" = 1 ]; then
  say "Installing OpenJDK 17 and Ghidra..."
  $APT install --no-install-recommends openjdk-17-jdk-headless || note_fail "openjdk-17"
  if [ ! -d /opt/ghidra ]; then
    T=$(mktemp -d)
    if curl -fsSL --retry 3 -o "$T/ghidra.zip" "$GHIDRA_URL"; then
      unzip -q -o "$T/ghidra.zip" -d "$T/x"
      mkdir -p /opt/ghidra
      mv "$T"/x/ghidra_*/* /opt/ghidra/
      ln -sfn /opt/ghidra/support/analyzeHeadless /usr/local/bin/ghidra-analyzeHeadless
    else
      note_fail "ghidra (could not download it; set GHIDRA_URL to a current release zip)"
    fi
    rm -r "$T"
  fi
fi

# ---- The developer account (the same "dev" user as the other dev tools: key-only, no sudo) ----
if ! id "$DEV_USER" >/dev/null 2>&1; then
  say "Creating user $DEV_USER..."
  useradd -m -s /bin/bash -p '*' "$DEV_USER"
fi
H=$(getent passwd "$DEV_USER" | cut -d: -f6)
if ! grep -q scudrace-path "$H/.bashrc" 2>/dev/null; then
  # Before .bashrc's "not interactive? stop" line, so ssh dev@host 'cmd' sees it too.
  { echo "export PATH=$VENV/bin:\$PATH PLAYWRIGHT_BROWSERS_PATH=/opt/playwright  # scudrace-path"; cat "$H/.bashrc" 2>/dev/null; } > "$H/.bashrc.new"
  mv "$H/.bashrc.new" "$H/.bashrc"
  chown "$DEV_USER:" "$H/.bashrc"
fi
# A checkout called scudracer in the dev user's home gets its .venv linked to the environment.
if [ -d "$H/scudracer" ] && [ ! -e "$H/scudracer/.venv" ]; then sudo -u "$DEV_USER" ln -s "$VENV" "$H/scudracer/.venv"; say "Linked $H/scudracer/.venv -> $VENV"; fi

# ---- Smoke check: versions, and every Python module the project imports ----
say "Checking the tools..."
{
  echo "installed $(date -u +%FT%TZ)"
  echo "machine $CORES cores, $MEM_GB GB RAM, $DISK_GB GB free"
  echo "git $(git --version 2>&1)"; echo "git-lfs $(git lfs version 2>&1 | head -1)"; echo "gh $(gh --version 2>&1 | head -1)"
  echo "python $("$VENV/bin/python" --version 2>&1)"
  echo "node $(node -v 2>&1) npm $(npm -v 2>&1)"
  echo "gltf-transform $(gltf-transform --version 2>&1 | head -1)"
  echo "blender $(blender -b --version 2>&1 | head -1)"
  echo "ffmpeg $(ffmpeg -version 2>&1 | head -1)"
  echo "imagemagick $( (convert -version 2>&1 || true) | head -1)"
  "$VENV/bin/python" - <<'PYCHECK' 2>&1 || true
mods = ["numpy", "scipy", "skimage", "PIL", "imageio", "imageio_ffmpeg", "matplotlib", "shapely", "networkx", "trimesh", "mapbox_earcut",
        "fast_simplification", "xatlas", "fontTools", "soundfile", "tifffile", "capstone", "z80dis", "requests", "cv2", "pytest"]
bad = []
for m in mods:
    try:
        __import__(m)
    except Exception as e:
        bad.append(m + " (" + str(e)[:60] + ")")
print("python modules: " + ("all import" if not bad else "PROBLEMS: " + ", ".join(bad)))
PYCHECK
  [ "$INSTALL_TORCH" = 1 ] && echo "torch $("$VENV/bin/python" -c 'import torch; print(torch.__version__)' 2>&1)"
  [ "$INSTALL_GHIDRA" = 1 ] && echo "ghidra $(ls /opt/ghidra 2>/dev/null | head -1) java $(java -version 2>&1 | head -1)"
  [ -z "$FAILED" ] && echo "problems: none" || echo "problems:$FAILED"
} | tee /opt/scudrace/READY
say "Done. Log in as $DEV_USER (sudo -iu $DEV_USER, or ssh $DEV_USER@<machine>). Put the GitHub token in the environment (GH_TOKEN), and ~/.scudrace_gemini_key / ~/.scudrace_leaderboard_group by hand when needed."
[ -z "$FAILED" ] || exit 2
`;

export const SCUDRACE_TOOLS_SHA256 = crypto.createHash('sha256').update(SCUDRACE_TOOLS_SCRIPT).digest('hex');
