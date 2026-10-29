/**
 * src/providers/shared/addons.ts: OPTIONAL ADD-ONS FOR A NEW MACHINE
 *
 * A generic catalog of tools you can tick when you launch a machine (or run by
 * hand later). Nothing is installed unless chosen, so a plain gaming machine
 * stays lean and AWS's 16 KB user-data limit isn't touched: the machine's setup
 * script only carries a short runner, which downloads each chosen add-on from
 *     GET /api/agent/addons/<id>.sh
 * checks its sha256, and runs them in order in the background after the machine
 * is playable. Log: /var/log/cg-addons.log; status: /var/lib/cg-addons/<id>.state
 *
 * Add-ons are idempotent (safe to re-run), take options from environment
 * variables, and contain nothing private. Tool licences / accounts / repos are
 * the user's to supply on the machine afterwards.
 * Must not contain backticks or "${" (String.raw templates).
 */

import crypto from 'crypto';

export interface AddonOption {
  key: string;
  label: string;
  default: string;
  /** Short hint shown under the field. */
  help?: string;
}

export interface AddonDef {
  id: string;
  name: string;
  description: string;
  /** Rough extra disk, GB (for the UI). */
  diskGb: number;
  /** Add-ons that must be installed first (resolved automatically). */
  requires: string[];
  options: AddonOption[];
  /** True when the install route is not tested end to end. */
  experimental?: boolean;
  script: string;
}

const HDR = String.raw`#!/bin/bash
set -euo pipefail
. /etc/os-release
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -y -q -o DPkg::Lock::Timeout=900"
say() { echo "[addon] $*"; }
opt() { printenv "$1" || echo "$2"; }
[ "$(id -u)" = 0 ] || { say "Run as root."; exit 1; }
[ "$(uname -m)" = x86_64 ] || { say "x86_64 machines only."; exit 1; }
dpkg --configure -a || true
`;

const script = (body: string) => HDR + body;

const DEV_BASE = script(String.raw`
$APT update || true
$APT install --no-install-recommends git git-lfs curl wget unzip zip xz-utils rsync jq bc tmux htop build-essential cmake pkg-config ca-certificates sudo
git lfs install --system || true
if ! id dev >/dev/null 2>&1; then useradd -m -s /bin/bash -p '*' dev; fi
for g in video render; do if getent group "$g" >/dev/null; then usermod -aG "$g" dev; fi; done
say "dev-base done. User dev exists (key-only SSH, passwordless sudo): sudo -iu dev"
`);

const PYTHON = script(String.raw`
V=$(opt PY_VENV /opt/devtools/venv)
PKGS=$(opt PY_PACKAGES "")
$APT update || true
$APT install --no-install-recommends python3 python3-venv python3-pip python3-dev
[ -x "$V/bin/python" ] || { mkdir -p "$(dirname "$V")"; python3 -m venv "$V"; }
"$V/bin/pip" install -q --upgrade pip wheel
if [ -n "$PKGS" ]; then "$V/bin/pip" install -q $(echo "$PKGS" | tr ',' ' '); fi
chmod -R a+rX "$V"
say "python done: $V/bin/python"
`);

const NODE = script(String.raw`
M=$(opt NODE_MAJOR 20)
if [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" != "$M" ]; then
  $APT update || true
  $APT install --no-install-recommends curl ca-certificates gnupg
  curl -fsSL --retry 3 "https://deb.nodesource.com/setup_$M.x" | bash -
  $APT install nodejs
fi
say "node done: $(node --version)"
`);

const GITHUB_CLI = script(String.raw`
if ! command -v gh >/dev/null 2>&1; then
  $APT update || true
  $APT install --no-install-recommends curl ca-certificates gnupg
  mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL --retry 3 https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg
  chmod go+r /etc/apt/keyrings/githubcli.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  $APT update
  $APT install gh
fi
say "github-cli done. Sign in with: gh auth login (or set GH_TOKEN)."
`);

const MEDIA = script(String.raw`
$APT update || true
$APT install --no-install-recommends ffmpeg sox flac vorbis-tools imagemagick libsndfile1
say "media-tools done."
`);

const HEADLESS_GPU = script(String.raw`
$APT update || true
ASOUND=libasound2
apt-cache show libasound2t64 >/dev/null 2>&1 && ASOUND=libasound2t64
$APT install --no-install-recommends xvfb xauth x11-utils x11-xserver-utils xclip libx11-6 libxcursor1 libxinerama1 libxrandr2 libxi6 libxkbcommon0 \
  libfontconfig1 libdbus-1-3 libudev1 "$ASOUND" libpulse0 libegl1 libgl1-mesa-dri libglx-mesa0 libvulkan1 vulkan-tools mesa-vulkan-drivers fonts-dejavu
say "headless-gpu done. Use xvfb-run -a <cmd> for offscreen runs; on-desktop <cmd> to show on the streamed desktop."
`);

const BROWSER_TEST = script(String.raw`
command -v npm >/dev/null 2>&1 || { say "Needs node."; exit 1; }
D=$(opt PLAYWRIGHT_DIR /opt/playwright)
mkdir -p "$D"
cd "$D"
[ -f package.json ] || npm init -y >/dev/null
npm install --no-fund --no-audit playwright
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright install --with-deps chromium
chmod -R a+rX /opt/pw-browsers "$D"
grep -q PLAYWRIGHT_BROWSERS_PATH /etc/environment || echo 'PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers' >> /etc/environment
say "browser-test done: headless Chromium via Playwright (NODE_PATH=$D/node_modules)."
`);

const GODOT = script(String.raw`
VER=$(opt GODOT_VERSION 4.7.2-stable)
GD=/opt/godot/$VER
if [ ! -x "$GD/godot" ]; then
  $APT update || true
  $APT install --no-install-recommends curl unzip ca-certificates
  T=$(mktemp -d)
  ZIP="Godot_v$VER"_linux.x86_64.zip
  BASE="https://github.com/godotengine/godot/releases/download/$VER"
  curl -fsSL --retry 3 -o "$T/$ZIP" "$BASE/$ZIP"
  curl -fsSL --retry 3 -o "$T/SUMS" "$BASE/SHA512-SUMS.txt"
  WANT=$(awk -v f="$ZIP" '$2 == f { print $1 }' "$T/SUMS")
  GOT=$(sha512sum "$T/$ZIP" | cut -d' ' -f1)
  if [ -z "$WANT" ] || [ "$WANT" != "$GOT" ]; then say "Godot download failed its checksum - not installed."; rm -r "$T"; exit 1; fi
  mkdir -p "$GD"
  unzip -q -o "$T/$ZIP" -d "$T/x"
  install -m 755 "$T/x/Godot_v$VER"_linux.x86_64 "$GD/godot"
  rm -r "$T"
fi
ln -sfn "$GD/godot" /usr/local/bin/godot
say "godot done: $(godot --headless --version 2>/dev/null | tail -1)"
`);

const WINE = script(String.raw`
$APT update || true
$APT install --no-install-recommends winbind cabextract winetricks zstd xvfb xauth curl ca-certificates
if ! dpkg -s winehq-stable >/dev/null 2>&1; then
  say "Installing WineHQ stable..."
  if dpkg --add-architecture i386 \
    && mkdir -pm755 /etc/apt/keyrings \
    && curl -fsSL --retry 3 -o /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key \
    && curl -fsSL --retry 3 -o /etc/apt/sources.list.d/winehq-"$VERSION_CODENAME".sources "https://dl.winehq.org/wine-builds/ubuntu/dists/$VERSION_CODENAME/winehq-$VERSION_CODENAME.sources" \
    && $APT update && $APT install --install-recommends winehq-stable; then
    say "WineHQ $(wine --version 2>/dev/null) installed."
  else
    say "WineHQ unavailable - using Ubuntu's Wine."
    rm -f /etc/apt/sources.list.d/winehq-"$VERSION_CODENAME".sources
    $APT update || true
    $APT install --no-install-recommends wine wine64
  fi
fi
id dev >/dev/null 2>&1 || useradd -m -s /bin/bash -p '*' dev
H=$(getent passwd dev | cut -d: -f6)
if ! grep -q cg-wine-env "$H/.bashrc" 2>/dev/null; then
  { echo "export WINEARCH=win64 WINEDEBUG=-all  # cg-wine-env"; cat "$H/.bashrc" 2>/dev/null; } > "$H/.bashrc.new"
  mv "$H/.bashrc.new" "$H/.bashrc"; chown dev: "$H/.bashrc"
fi
if [ ! -f "$H/.wine/system.reg" ]; then
  say "Creating the 64-bit WINE prefix..."
  sudo -u dev -H env WINEARCH=win64 WINEPREFIX="$H/.wine" WINEDEBUG=-all WINEDLLOVERRIDES="mscoree,mshtml=" \
    xvfb-run -a sh -c 'wineboot -i && wineserver -w' >/dev/null 2>&1 || say "Prefix setup reported a problem - run wineboot -i as dev."
fi
if [ "$(opt WINE_DXVK 1)" = 1 ]; then
  DXVK=2.7.1; DXVK_SHA=d85ce7c79f57ecd765aaa1b9e7007cb875e6fde9f6d331df799bce73d513ce87
  VKD3D=3.0.1; VKD3D_SHA=3cf2315522af5e43605ef6d3c41dad91387040bf97199934f3f7ab76caaa2f0c
  WM=$( (wine --version 2>/dev/null || true) | grep -oE '^wine-[0-9]+' | grep -oE '[0-9]+' || true); WM=$(( 10#0$WM ))
  if [ "$WM" -lt 9 ] || [ ! -d "$H/.wine/drive_c/windows/system32" ]; then
    say "DXVK/VKD3D-Proton skipped (Wine too old or no prefix)."
  elif [ "$(cat "$H/.wine/.cg-d3d" 2>/dev/null)" != "dxvk-$DXVK vkd3d-$VKD3D" ]; then
    T=$(mktemp -d)
    curl -fsSL --retry 3 -o "$T/dxvk.tgz" "https://github.com/doitsujin/dxvk/releases/download/v$DXVK/dxvk-$DXVK.tar.gz" || true
    curl -fsSL --retry 3 -o "$T/vkd3d.tzst" "https://github.com/HansKristian-Work/vkd3d-proton/releases/download/v$VKD3D/vkd3d-proton-$VKD3D.tar.zst" || true
    if [ "$(sha256sum < "$T/dxvk.tgz" 2>/dev/null | cut -c1-64)" != "$DXVK_SHA" ] || [ "$(sha256sum < "$T/vkd3d.tzst" 2>/dev/null | cut -c1-64)" != "$VKD3D_SHA" ]; then
      say "DXVK/VKD3D-Proton download failed its checksum - skipped."
    else
      tar -xzf "$T/dxvk.tgz" -C "$T"; tar --zstd -xf "$T/vkd3d.tzst" -C "$T"
      W="$H/.wine/drive_c/windows"
      install -o dev -m 644 "$T/dxvk-$DXVK"/x64/*.dll "$T/vkd3d-proton-$VKD3D"/x64/*.dll "$W/system32/"
      if [ -d "$W/syswow64" ]; then install -o dev -m 644 "$T/dxvk-$DXVK"/x32/*.dll "$T/vkd3d-proton-$VKD3D"/x86/*.dll "$W/syswow64/"; fi
      for d in d3d8 d3d9 d3d10core d3d11 dxgi d3d12 d3d12core; do
        sudo -u dev -H env WINEPREFIX="$H/.wine" WINEDEBUG=-all wine reg add 'HKEY_CURRENT_USER\Software\Wine\DllOverrides' /v "$d" /d native /f >/dev/null 2>&1 || true
      done
      sudo -u dev -H env WINEPREFIX="$H/.wine" wineserver -w || true
      echo "dxvk-$DXVK vkd3d-$VKD3D" > "$H/.wine/.cg-d3d"
    fi
    rm -r "$T"
  fi
fi
say "wine done: $(wine --version 2>/dev/null || echo missing)"
`);

const BLENDER = script(String.raw`
VER=$(opt BLENDER_VERSION 4.2.3)
MAJ=$(echo "$VER" | cut -d. -f1-2)
D=/opt/blender/$VER
if [ ! -x "$D/blender" ]; then
  $APT update || true
  $APT install --no-install-recommends curl xz-utils ca-certificates libxi6 libxxf86vm1 libxfixes3 libxrender1 libgl1 libegl1 libxkbcommon0 libsm6
  T=$(mktemp -d)
  F="blender-$VER-linux-x64.tar.xz"
  BASE="https://download.blender.org/release/Blender$MAJ"
  curl -fsSL --retry 3 -o "$T/$F" "$BASE/$F"
  curl -fsSL --retry 3 -o "$T/SUM" "$BASE/blender-$VER.sha256"
  WANT=$(awk -v f="$F" '$2 == f || $2 == "*" f { print $1 }' "$T/SUM")
  GOT=$(sha256sum "$T/$F" | cut -d' ' -f1)
  if [ -z "$WANT" ] || [ "$WANT" != "$GOT" ]; then say "Blender download failed its checksum - not installed."; rm -r "$T"; exit 1; fi
  mkdir -p "$D"; tar -xJf "$T/$F" -C "$D" --strip-components=1; rm -r "$T"
fi
ln -sfn "$D/blender" /usr/local/bin/blender
say "blender done: $(blender --background --version 2>/dev/null | head -1)"
`);


const CLAUDE_CODE = script(String.raw`
command -v npm >/dev/null 2>&1 || { say "Needs node."; exit 1; }
npm install -g --no-fund --no-audit @anthropic-ai/claude-code
say "claude-code done: $(claude --version 2>/dev/null || echo installed). Sign in yourself: sudo -iu dev, then run claude (it prints a login link to open in your own browser)."
`);

const GDRIVE = script(String.raw`
# Google has no Linux Drive app: this is rclone, which mounts a Drive as a folder.
$APT update || true
$APT install --no-install-recommends rclone fuse3 ca-certificates
id dev >/dev/null 2>&1 || useradd -m -s /bin/bash -p '*' dev
grep -q '^user_allow_other' /etc/fuse.conf 2>/dev/null || echo user_allow_other >> /etc/fuse.conf
R=$(opt GDRIVE_REMOTE gdrive)
cat > /usr/local/bin/gdrive-mount <<GM
#!/bin/sh
# Mount the rclone remote "$R" at ~/GoogleDrive (as the user running this).
rclone listremotes 2>/dev/null | grep -q '^$R:' || { echo "No rclone remote named $R yet. Set it up once: rclone config  (see the notes: headless sign-in uses rclone authorize drive on a computer with a browser)."; exit 1; }
mkdir -p "\$HOME/GoogleDrive"
rclone mount $R: "\$HOME/GoogleDrive" --daemon --vfs-cache-mode full --vfs-cache-max-size 10G --dir-cache-time 5m
echo "Mounted at \$HOME/GoogleDrive. Unmount: gdrive-umount"
GM
cat > /usr/local/bin/gdrive-umount <<'GU'
#!/bin/sh
fusermount3 -u "$HOME/GoogleDrive" 2>/dev/null || fusermount -u "$HOME/GoogleDrive"
GU
chmod 755 /usr/local/bin/gdrive-mount /usr/local/bin/gdrive-umount
say "google-drive done (rclone $(rclone version 2>/dev/null | head -1)). Not signed in: as dev run rclone config (new remote, type drive, name $R), then gdrive-mount."
`);

const UNITY = script(String.raw`
# EXPERIMENTAL. Installs the Unity Editor through the Unity Hub command line.
# No licence is activated: do that yourself (see the notes at the end).
VER=$(opt UNITY_VERSION 6000.3.27f1)
MODS=$(opt UNITY_MODULES linux-il2cpp,linux-mono,windows-mono,windows-il2cpp,mac-mono)
DISK=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
[ "$DISK" -ge 45 ] || { say "Unity needs about 45 GB free (have $DISK). Raise the disk size and retry."; exit 1; }
$APT update || true
ASOUND=libasound2
apt-cache show libasound2t64 >/dev/null 2>&1 && ASOUND=libasound2t64
$APT install --no-install-recommends curl ca-certificates gnupg xvfb xauth libgbm1 libnss3 libgtk-3-0 libxss1 "$ASOUND" libsecret-1-0 libgl1 libvulkan1 libfuse2 zenity fonts-dejavu unzip
if [ ! -x /opt/unityhub/unityhub ] && ! command -v unityhub >/dev/null 2>&1; then
  mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL --retry 3 https://hub.unity3d.com/linux/keys/public | gpg --dearmor -o /etc/apt/keyrings/unityhub.gpg
  echo "deb [signed-by=/etc/apt/keyrings/unityhub.gpg] https://hub.unity3d.com/linux/repos/deb stable main" > /etc/apt/sources.list.d/unityhub.list
  $APT update
  $APT install unityhub
fi
HUB=$(command -v unityhub || echo /opt/unityhub/unityhub)
id dev >/dev/null 2>&1 || useradd -m -s /bin/bash -p '*' dev
MFLAGS=""
for m in $(echo "$MODS" | tr ',' ' '); do MFLAGS="$MFLAGS -m $m"; done
say "Installing Unity $VER with modules: $MODS (large download; can take 20+ minutes)..."
if sudo -u dev -H xvfb-run -a "$HUB" --headless install --version "$VER" $MFLAGS; then
  say "Unity $VER installed."
else
  say "PROBLEM: the Unity Hub install failed (version/changeset lookup or a module name). Unity is not usable yet."
  say "Retry by hand as dev: xvfb-run -a unityhub --headless install --version $VER -m linux-il2cpp"
  exit 1
fi
cat <<'NOTE'
Unity is installed but NOT licensed. Activate it yourself (Personal licence needs an
account): run the Hub or the Editor as the dev user with -batchmode -serial/-username,
or copy a licence file (Unity_lic.ulf) to ~dev/.local/share/unity3d/Unity/ . Builds that
run before activation will fail with a licence error.
NOTE
`);

export const ADDONS: AddonDef[] = [
  { id: 'dev-base', name: 'Developer basics', diskGb: 2, requires: [], options: [],
    description: 'git, git-lfs, build tools, cmake, jq, tmux, rsync, zip, and a "dev" login (key-only SSH, passwordless sudo).', script: DEV_BASE },
  { id: 'python', name: 'Python environment', diskGb: 1, requires: ['dev-base'],
    options: [
      { key: 'PY_PACKAGES', label: 'pip packages', default: '', help: 'Comma-separated, e.g. numpy,pillow,scipy' },
      { key: 'PY_VENV', label: 'Venv path', default: '/opt/devtools/venv' },
    ], description: 'Python 3 with a shared virtual environment, plus any pip packages you list.', script: PYTHON },
  { id: 'node', name: 'Node.js', diskGb: 1, requires: [],
    options: [{ key: 'NODE_MAJOR', label: 'Major version', default: '20' }],
    description: 'Node.js and npm from NodeSource.', script: NODE },
  { id: 'github-cli', name: 'GitHub CLI', diskGb: 0.1, requires: [], options: [],
    description: 'gh, for cloning private repos and talking to GitHub (you sign in yourself).', script: GITHUB_CLI },
  { id: 'media-tools', name: 'Audio / video / image tools', diskGb: 1, requires: [], options: [],
    description: 'ffmpeg, sox, flac, ImageMagick, libsndfile.', script: MEDIA },
  { id: 'headless-gpu', name: 'Headless graphics runtime', diskGb: 1, requires: [],
    options: [], description: 'Xvfb, Vulkan tools and the libraries engines need to run offscreen.', script: HEADLESS_GPU },
  { id: 'browser-test', name: 'Headless browser (Playwright)', diskGb: 1.5, requires: ['node'], options: [],
    description: 'Playwright with Chromium, for browser-based tests and screenshots.', script: BROWSER_TEST },
  { id: 'godot', name: 'Godot (headless)', diskGb: 0.3, requires: ['dev-base', 'headless-gpu'],
    options: [{ key: 'GODOT_VERSION', label: 'Version', default: '4.7.2-stable', help: 'A Godot release tag' }],
    description: 'Godot engine from the official release, checksum-verified.', script: GODOT },
  { id: 'wine', name: 'Wine + DXVK (run Windows builds)', diskGb: 3, requires: ['dev-base', 'headless-gpu'],
    options: [{ key: 'WINE_DXVK', label: 'Add DXVK / VKD3D-Proton (1/0)', default: '1' }],
    description: 'WineHQ with a 64-bit prefix for the dev user, for smoke-testing Windows executables on the GPU.', script: WINE },
  { id: 'blender', name: 'Blender (headless)', diskGb: 1.5, requires: [],
    options: [{ key: 'BLENDER_VERSION', label: 'Version', default: '4.2.3' }],
    description: 'Blender from blender.org (checksum-verified) for scripted model work.', script: BLENDER },
  { id: 'claude-code', name: 'Claude Code (CLI)', diskGb: 0.5, requires: ['node'], options: [],
    description: 'Anthropic\'s Claude Code command-line tool. You sign in on the machine; no key is installed. (There is no Linux Claude Desktop app.)', script: CLAUDE_CODE },
  { id: 'google-drive', name: 'Google Drive (rclone mount)', diskGb: 0.2, requires: ['dev-base'],
    options: [{ key: 'GDRIVE_REMOTE', label: 'rclone remote name', default: 'gdrive' }],
    description: 'Google has no Linux Drive app, so this installs rclone and a gdrive-mount command. You sign in to Google once yourself.', script: GDRIVE },
  { id: 'unity', name: 'Unity Editor', diskGb: 30, requires: ['dev-base'], experimental: true,
    options: [
      { key: 'UNITY_VERSION', label: 'Editor version', default: '6000.3.27f1' },
      { key: 'UNITY_MODULES', label: 'Modules', default: 'linux-il2cpp,linux-mono,windows-mono,windows-il2cpp,mac-mono', help: 'Comma-separated Hub module ids' },
    ], description: 'Unity via Unity Hub headless install. Not licensed: you activate it. Untested install route.', script: UNITY },
];

export interface AddonBundle { id: string; name: string; addons: string[] }
export const ADDON_BUNDLES: AddonBundle[] = [
  { id: 'developer', name: 'Developer', addons: ['dev-base', 'python', 'node', 'github-cli'] },
  { id: 'game-test', name: 'Game build & test', addons: ['dev-base', 'headless-gpu', 'godot', 'wine', 'python', 'media-tools'] },
];

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
/** What a machine gets: the script without its comment lines. sha256 is of exactly this. */
const strip = (s: string) => s.split('\n').filter((l, i) => i === 0 || !/^\s*#(?!!)/.test(l)).join('\n');
const SERVED = new Map(ADDONS.map((a) => [a.id, strip(a.script)]));
const SHAS = new Map([...SERVED].map(([id, s]) => [id, sha(s)]));
const BY_ID = new Map(ADDONS.map((a) => [a.id, a]));

export function addonScript(id: string): string | undefined { return SERVED.get(id); }

/** Catalog for the UI (no scripts). */
export function addonCatalog() {
  return {
    addons: ADDONS.map(({ script: _s, ...a }) => a),
    bundles: ADDON_BUNDLES,
  };
}

export interface AddonSelection { id: string; options?: Record<string, string> }

const VALUE_RE = /^[A-Za-z0-9._:+,\/-]{0,200}$/;

/** Validate a request's selection: known ids, known option keys, safe values. Throws on bad input. */
export function validateAddons(input: unknown): AddonSelection[] {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 30) throw new Error('addons must be a list');
  const out: AddonSelection[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const id = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw as any).id : undefined);
    const def = typeof id === 'string' ? BY_ID.get(id) : undefined;
    if (!def) throw new Error(`Unknown add-on: ${String(id).slice(0, 40)}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const given = (raw && typeof raw === 'object' && (raw as any).options) || {};
    const options: Record<string, string> = {};
    for (const [k, v] of Object.entries(given as Record<string, unknown>)) {
      const o = def.options.find((x) => x.key === k);
      if (!o) throw new Error(`Unknown option ${k.slice(0, 40)} for ${def.name}`);
      const val = String(v ?? '').trim();
      if (!VALUE_RE.test(val)) throw new Error(`Bad value for ${o.label}: use letters, digits and . _ : + , / - only`);
      if (val !== o.default) options[k] = val;
    }
    out.push({ id, ...(Object.keys(options).length ? { options } : {}) });
  }
  return out;
}

/** Selected add-ons plus everything they require, in install order. */
export function resolveAddons(sel: AddonSelection[]): AddonSelection[] {
  const chosen = new Map(sel.map((s) => [s.id, s]));
  const order: AddonSelection[] = [];
  const done = new Set<string>();
  const visit = (id: string, depth = 0) => {
    if (done.has(id) || depth > 10) return;
    const def = BY_ID.get(id);
    if (!def) return;
    for (const r of def.requires) visit(r, depth + 1);
    done.add(id);
    order.push(chosen.get(id) || { id });
  };
  for (const s of sel) visit(s.id);
  return order;
}

/**
 * Lines for the setup script: one "cg_addon <id> <sha> '<KEY=val ...>'" per add-on,
 * in install order. Values were validated, so quoting is safe.
 */
export function addonRunnerLines(input: unknown): string {
  return resolveAddons(validateAddons(input)).map((s) => {
    const env = Object.entries(s.options || {}).map(([k, v]) => `${k}=${v}`).join(' ');
    return `cg_addon ${s.id} ${SHAS.get(s.id)} '${env}'`;
  }).join('\n');
}
