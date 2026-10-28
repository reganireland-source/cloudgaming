# Scud Race Revisited developer profile (`scudrace-tools`)

An **optional** install script for a Linux machine you choose, for everything the Scud Race Revisited project does except the Unity builds (those stay on the Windows PC and the Mac). It is not part of any machine's gaming setup: other machines stay lean and AWS's user-data limit is untouched.

**Name to select it:** `scudrace-tools`

```bash
curl -fsSL https://cloudgaming-production.up.railway.app/api/agent/scudrace-tools.sh | sudo bash
```

Extras (environment variables, kept through `sudo`):

```bash
curl -fsSL https://cloudgaming-production.up.railway.app/api/agent/scudrace-tools.sh | sudo INSTALL_TORCH=1 INSTALL_GHIDRA=1 bash
```

- `INSTALL_TORCH=1`: CPU PyTorch, for the texture upscaling (`tools/remaster/upscale.py`). No GPU needed.
- `INSTALL_GHIDRA=1`: OpenJDK 17 + Ghidra (default 11.2.1; set `GHIDRA_URL` to another release zip). The ROM-derived data is already in the repo, so most tasks do not need it.
- `BLENDER_VERSION=4.2.3`: another Blender 4.x.

Safe to run again (it repairs or updates). Source: `src/providers/shared/scudraceTools.ts`, served at `GET /api/agent/scudrace-tools.sh`.

## What it installs
- **Base:** git, git-lfs (`git lfs install --system`), GitHub CLI `gh`, build-essential, cmake, unzip/zip, rsync, curl, jq, tar/zstd/gzip, sqlite3, ffmpeg, ImageMagick, DejaVu and Liberation fonts.
- **Python:** 3.11+ (from the deadsnakes PPA on Ubuntu 22.04; 24.04 has it) in a venv at `/opt/scudrace/venv` with numpy, scipy, scikit-image, pillow, imageio, imageio-ffmpeg, matplotlib, shapely, networkx, trimesh, mapbox_earcut, fast_simplification, xatlas, fonttools, soundfile, tifffile, capstone, z80dis, requests, opencv-python-headless and pytest.
- **Libraries** Blender headless needs: libsndfile1, libgl1, libglib2.0-0, libegl1, libxrender1, libxi6, libxkbcommon0 and friends.
- **Blender** 4.2.3 (headless) from Blender's official tarball, verified against Blender's own SHA-256 file, at `/usr/local/bin/blender`. CPU rendering (Cycles) is fine; EEVEE may not work headless.
- **Node.js 20 LTS** with `@gltf-transform/cli`, `gltfpack` and Playwright with Chromium (browsers in `/opt/playwright`). `toktx`/KTX-Software and `basisu` are not included (optional; no reliable package).
- **The `dev` user** (the same key-only, no-sudo user as the other dev tools). Its shell gets the venv first on `PATH`. If `~dev/scudracer` exists, its `.venv` is linked to the venv.

## Secrets
Nothing secret is installed. The GitHub token is read from `GH_TOKEN` / `GITHUB_TOKEN` in the environment (never stored by the script). The Gemini key (`~/.scudrace_gemini_key`) and the leaderboard group code (`~/.scudrace_leaderboard_group`) are placed by hand.

## Smoke check
The script ends with a report (also saved to `/opt/scudrace/READY`): versions of git, git-lfs, gh, Python, Node, `gltf-transform`, Blender, ffmpeg and ImageMagick; whether every Python module imports; and a "problems:" line (the script exits 2 if anything failed). Then, in the repo:

```bash
python -m pytest tools/qa/test_rung_gate.py tools/replay tools/leaderboard/test_leaderboard.py
blender -b --version; ffmpeg -version; gltf-transform --version
```

## Machine size
The project wants 4+ cores, 16 GB RAM and 100 GB of disk (the repo has a large LFS set and local analysis outputs). The script prints what the machine has and warns when it is short (under 4 cores, 16 GB RAM or 60 GB free).

## Not verified
The package set resolves on PyPI, and the script passes `bash -n`, but it has not been run end to end on a fresh Ubuntu machine. If a step fails, the script carries on, lists the problem at the end and exits 2; re-running after a fix repairs it.
