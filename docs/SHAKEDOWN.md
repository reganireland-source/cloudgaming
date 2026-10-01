# Shakedown runbook — first real launch (Google Cloud)

A checklist for the first end-to-end test: deploy → keys → launch → stream →
stop → clean up. Budget about 45 minutes and about $1–2 of cloud spend.
Each step says what "good" looks like and what to do if it isn't.

---

## 0. Before you sit down

**Is GPU quota approved?** New projects start at 0 GPUs, and approval can take
from minutes to 2 business days. Check in Cloud Shell:

```bash
P=cloudgaming-509906; R=asia-southeast1
gcloud compute project-info describe --project $P --flatten=quotas \
  --filter="quotas.metric~GPUS" --format="table(quotas.metric,quotas.limit,quotas.usage)"
gcloud compute regions describe $R --project $P --flatten=quotas \
  --filter="quotas.metric~GPU" --format="table(quotas.metric,quotas.limit,quotas.usage)"
```

You need **`GPUS_ALL_REGIONS` ≥ 1** and **`NVIDIA_T4_GPUS` ≥ 1** in your region
(for L4 machines, `NVIDIA_L4_GPUS`; for spot, the `PREEMPTIBLE_…` versions).
To request more from the command line:

```bash
gcloud services enable cloudquotas.googleapis.com --project $P
gcloud beta quotas info list --service=compute.googleapis.com --project=$P \
  --filter="quotaId~GPU" --format="value(quotaId)"          # exact IDs
gcloud beta quotas preferences create --project=$P --service=compute.googleapis.com \
  --quota-id=<ID> --preferred-value=1 --dimensions=region=$R \
  --email=<you> --justification="Personal cloud gaming VM, 1 GPU"
# (the all-regions quota: same command without --dimensions)
```

**Free trial?** GPUs are blocked on trial accounts. Billing → *Activate full account*.

**Easier:** once your keys are saved, open **Regions** in the app. It runs these
checks against every cloud and region and shows *Ready / No quota / Not enabled*
with the exact fix (console link and CLI) per region. Recon shows the same badge
on every option, so a "best" region you have no quota for still shows up, marked
as needing setup.

---

## 1. Deploy and run the pre-flight check  (≈5 min)

1. Railway: the backend redeploys from `main` on its own. Check its deploy
   log ends with `[migrate] Done` and `… backend running on port …`.
2. Vercel: same for the frontend.
3. Open **`https://<your-vercel-app>/preflight`**, signed in.

**Good:** a green "Ready for launch" banner. Amber `!` items are optional
(Google/Apple sign-in, Azure live prices…).
**Red `✗`:** each item says where to fix it. The usual ones:

| Item | Fix |
|---|---|
| Backend address (NEXT_PUBLIC_API_URL) | Vercel → Settings → Environment Variables → `https://<app>.up.railway.app/api`, then **Redeploy** (it's baked in at build time) |
| Website allowed to call the API (FRONTEND_URL) | Railway → Variables → `FRONTEND_URL=https://<app>.vercel.app` (no trailing slash) |
| Database tables up to date | Redeploy the backend; look for a `[migrate]` error in its log |
| Your GCP keys: can't be decrypted | `CREDENTIALS_ENCRYPTION_KEY` changed. Remove and re-add the keys on Config |

---

## 2. Cloud keys  (≈3 min)

Config → Google Cloud → paste the service-account JSON (role **Compute Admin**).
The checks run live:

- ✓ Key file format / Private key / Sign in to Google Cloud
- ✓ **GPU quota (all regions)**. If this is amber, step 0 isn't done yet.
- ✓ Network

---

## 3. Launch the cheapest reliable machine  (≈1 min)

Keep the first run simple: **Recon** → your city → *Classic* (GOOD tier,
T4, 1080p60) → **Reliable** pricing → **LAUNCH** on the top GCP row.
In the launch form: 150 GB disk, **auto-stop 15 min**, streaming quality *Good*.

Why this one: T4 is the most widely available GPU with the smallest quota
ask, and on-demand can't be reclaimed mid-test.

---

## 4. Watch it build  (≈20–35 min, first boot only)

The live log (Machines → the machine → Activity) and the setup progress bar
come from the machine's own serial console:

| % | Stage | Typical time |
|---|---|---|
| — | Creating network, firewall, disk, VM | 1–2 min |
| 5 | Machine booted, starting setup | |
| 10 | Package lists and build tools | 1–2 min |
| 14 | Kernel modules for the GPU | |
| 20 | **NVIDIA driver** | 5–10 min |
| 30 | Reboot to load the driver | 1–2 min |
| 35 | Checking the GPU | |
| 45 / 52 | Docker, NVIDIA container toolkit | 2–3 min |
| 60 / 65 | Sunshine container config, **download (several GB)** | 3–10 min |
| 70 | Adding Chrome, Discord and Battle.net | 2–4 min |
| 75 / 85 | Starting Sunshine, waiting for healthy | 1–3 min |
| 100 | **Ready to stream** | |

Later starts skip all of this (about 1–2 minutes).

### If it fails, the error card says why

The card starts with the **cause**: *Quota* or *Region* (your account's setup;
see Regions), *Permissions* or *Keys* (the key's role; see Config), *Account*
(billing or trial), or *Out of stock* (the cloud's temporary shortage, not
yours). The GCP ones:

| Card title | What it means | Fix |
|---|---|---|
| Your project isn't allowed any GPUs yet | Global GPU quota is 0 | Step 0; wait for approval email |
| No NVIDIA T4 GPUs quota in *region* | Regional quota is 0 | Request it, or pick another region/GPU on Recon |
| Google is out of these GPUs in this area right now | Zone stock-out (common for GPUs) | Retry later, or another region. The app already tries every zone |
| The Compute Engine API is switched off | API not enabled | The card's button opens the page. Press *Enable*, wait 1–2 min, retry |
| Billing isn't active on this project | No/closed billing account | Link billing in the console |
| Google rejected the service account key | Key deleted/disabled or wrong project | Make a new JSON key; re-add on Config |
| Your organisation blocks … public IP addresses | Org policy `compute.vmExternalIpAccess` | Disable the policy like you did for key creation |
| Setup stuck at one % for > 20 min | Something on the machine failed | Machines → *Sync*; if still stuck, send me the Activity log |

---

## 5. Stream  (≈5 min)

Machine card → **Connect** shows three ways in:

| Way | What it's for | Needs |
|---|---|---|
| **Moonlight app** | Games: full quality, lowest lag, controllers | Moonlight installed once per device |
| **Use the desktop** (KasmVNC) | Desktop work in a browser tab: installing things, signing in to launchers, **copy & paste** between your computer and the machine. ~30 fps, not for games | Any browser |
| **Play in browser** (Moonlight Web) — *experimental* | The full GPU stream in Chrome/Edge with no app | Chrome or Edge; UDP 40000–40030 reachable |

Both browser options sign in with the machine's username/password (shown on
the card) and warn once about the machine's own certificate (Advanced →
Proceed). Play in browser is paired with Sunshine automatically during setup;
in the player pick the machine, then an app. Machines set up before browser
access existed show "Not on this machine" — launch a new one.

Machine card → **Play with Moonlight**:

1. **Pair Moonlight (one click)**: once per device.
2. Moonlight → the machine → pick an app. Every machine has **Steam** (and
   Big Picture), **Battle.net**, **Discord**, **Google Chrome**, **Heroic**
   (Epic & GOG), **Lutris**, **Firefox** and the full **Desktop**. Sign in to
   Steam and install a small game first. **Battle.net** is pre-installed in
   the background during the first setup (through Proton, no Lutris wizard):
   opening it should go straight to the Blizzard login. If you open it before
   that finishes it says so and opens when ready; if the pre-install failed
   (log: `docker exec cloudy cat /var/log/cloudy/battlenet-preinstall.log`,
   or the CloudyPad log dir), the first launch falls back to Lutris's
   installer (click through once).
   Log in by scanning the **QR code** on the Steam / Discord / Battle.net
   login screen with their phone app. Logins stay on the machine through
   stop/start; check this by stopping and starting once and confirming
   you're still logged in.
3. Press **Ctrl + Alt + Shift + S** in Moonlight for its stats overlay.

**Good numbers:** network latency ≈ the Recon estimate (±15 ms), decode time
< 5 ms, frame drops near 0, FPS steady at 60.
**Battle.net installer stops with "Install UMU to use Proton"?** Lutris needs
the UMU launcher for Proton-based Wine. Machines launched after 28 Sep 2026
(image recipe v4) have it built in; the machine's serial log says
`UMU for Lutris/Proton: /usr/local/bin/umu-run` (or `MISSING`). On an older
machine, launch a new one, or open a terminal on the desktop and run:

```bash
mkdir -p ~/.local/share/lutris/runtime/umu ~/.local/bin /tmp/umux
curl -fsSL https://api.github.com/repos/Open-Wine-Components/umu-launcher/releases/latest \
  | grep -o 'https://[^"]*zipapp\.tar' | head -1 | xargs curl -fL -o /tmp/umu.tar
tar -xf /tmp/umu.tar -C /tmp/umux
cp "$(find /tmp/umux -name umu-run -type f | head -1)" ~/.local/share/lutris/runtime/umu/umu-run
ln -sf ~/.local/share/lutris/runtime/umu/umu-run ~/.local/bin/umu-run
```

Then close Lutris completely and start Battle.net again. (It's kept across
reboots: the home folder lives on the disk.) Alternatively, in the installer's
Wine version list pick a non-Proton build (e.g. `wine-ge-8-26`).

**Battle.net installer stops with "The 'DXVK' runtime component is not
installed"?** Lutris 0.5.20 only downloads its components (DXVK, VKD3D...)
when its main window opens; the Battle.net shortcut went straight to the
installer. Machines launched after 28 Sep 2026 (image recipe v6) fetch them at
container start and before the first install. On an older machine: Abort,
open **Lutris** from the dock, wait for the component download (bottom of the
window) or use ☰ → Preferences → Updates → *Check for updates*, then start
Battle.net again.

**Won't launch?** Games with kernel anti-cheat (Valorant, Fortnite, Apex,
PUBG, Call of Duty…) are blocked on Linux. Check <https://www.protondb.com>.

---

## 6. Stop, check costs, clean up  (≈5 min)

1. **Stop** the machine (or leave it idle 15 min and watch auto-stop do it).
   Status should go *stopping → stopped*. The status job re-checks the cloud
   every 5 minutes.
2. **Dashboard:** "Running now" back to $0.00/h; "Standing cost" shows the
   disk (≈$16/month for a 150 GB GCP disk while it exists).
3. **Map:** the machine appears in its region; **Leftovers = 0**.
4. Done testing? **Delete** the machine, then confirm on the Map (and the
   GCP console → Compute Engine) that nothing is left billing.

### Standing costs: shelve instead of leaving it stopped

A stopped machine has no compute charge, but its **whole disk** is billed every
month, empty space included (150 GB ≈ $16.50 on GCP, $14.40 AWS, $22.50 Azure,
$6.40 Oracle). **Shelve** (Machines → a stopped machine) snapshots the disk and
then deletes the machine and disk; snapshots bill only the data actually
stored, typically **$1–5/month**. **Restore** rebuilds it (≈5–15 min plus a
quick start-up check) with games, logins and Moonlight pairing kept; only the
IP changes. On GCP and AWS you can restore in a **different region**, which is
handy when travelling.

- The disk is deleted **only after** the cloud confirms the snapshot is
  complete. If the snapshot fails or stalls, nothing is deleted.
- **Auto-shelve** (launch form, or each machine card) shelves a machine after
  N days stopped. 7 days is the default for new machines.
- **Costs → Standing costs** lists everything billed while idle, worst first:
  leftovers (red), things that could be cheaper (amber, with one-click Shelve
  or Delete snapshot), and things that are fine.

**Test it once:** stop → Shelve → check the card says *shelved* and the
standing cost dropped → Restore → Moonlight connects (new IP).

### A machine stuck on "stopping" / "starting"

The app re-reads every machine's real state from the cloud every 5 minutes,
including ones mid-change, and gives up waiting on an action that runs far too
long (30 min; shelve 150, restore 90). The Machines page also re-checks a
machine automatically once it has been mid-change for 10+ minutes. **Sync**
always works if you don't want to wait. (On Azure, a machine that shut itself
down shows "stopping" for a few minutes while Azure releases it; that is
what stops the billing.)

### Estimates vs the actual bill

The app's own figures are **estimates in USD** from list prices, recorded
hourly. **Costs → Estimate vs billed** shows, per cloud, what the cloud
actually billed this month **in your billing currency** (e.g. SGD), up to the
last day it has reported (clouds lag 8–24 h), its USD equivalent at the ECB
rate, the app's estimate for the same days, and the difference. The month
projection uses billed amounts where reported and estimates for the rest.
"Also show in" adds a second currency to the totals.

What each cloud needs (the Costs page shows the exact fix if missing):

| Cloud | Source | Permission / setup |
|---|---|---|
| AWS | Cost Explorer | `ce:GetCostAndUsage` (+ `ce:UpdateCostAllocationTagsStatus` to split out the app's own resources). USD 0.01 per request; asked at most every 6 h |
| Azure | Cost Management | nothing extra (Contributor can read it); not available on free-trial/sponsorship subscriptions |
| Google Cloud | Billing export to BigQuery | one-time export setup + BigQuery Job User / Data Viewer; paste the table name on the Costs page. Data starts the day it's enabled |
| Oracle | Usage API | policy `Allow group CloudGaming to read usage-report in tenancy` |

---

## 7. Optional second run: spot

Recon → **Spot · big & cheap** → take the "Go large for less" suggestion.
Expect the same build, then a machine that may be stopped by Google with 30
seconds' warning. Its disk is kept, and *Start* brings it back when capacity
returns.

---

## What to send me if something breaks

- A screenshot of the **error card**, and the **Activity log** (Machines →
  machine → Activity → copy).
- The **pre-flight** page (screenshot).
- For setup failures: the last lines of the GCP **serial console**
  (Compute Engine → VM → *Serial port 1*). Look for `CLOUDGAMING_STAGE`
  lines.

## Big screen (experimental): GRID driver, screens up to 4096×2160

Datacenter GPUs stream at most **2560×1600** with NVIDIA's standard driver.
Ticking **Big screen** in the launch form installs the cloud's licensed
**GRID** (virtual workstation) driver instead, which allows up to
**4096×2160** per screen.

| Cloud | Driver | Licence | Extra cost | Quota |
|---|---|---|---|---|
| AWS (g4dn T4, g5 A10G) | AWS's `…-grid-aws.run` (anonymous S3 bucket, newest in `latest/`) | Included | None | Same as normal |
| Azure (NCasT4_v3) | Microsoft's `NVIDIA-Linux-x86_64-595.58.03-grid-azure.run` | Included (`gridd.conf` set up automatically) | None | Same as normal |
| Google (T4, L4) | Newest `GRID/vGPU*/…-grid*.run` in Google's public bucket | Via **vWS** GPUs (`nvidia-tesla-t4-vws`, `nvidia-l4-vws`) | ≈USD 0.20 per GPU-hour (estimate) | **Separate**: request "NVIDIA T4/L4 Virtual Workstation GPUs" first |
| Oracle | — | Bring-your-own NVIDIA licence | — | Not offered |

**What to check when testing** (not yet tested end to end):

1. Launch with **Big screen** ticked (AWS or Azure first: no extra cost or quota).
2. Setup progress should say *"Installing the NVIDIA GRID driver…"*, reboot once, then
   the activity log shows **`GRID driver … licence status '…'`**. Expect
   `Licensed` (or similar). *Unlicensed* GRID drivers slow down after about
   20 minutes, so note what it says.
3. In the machine card: **BIG SCREEN · EXP** badge. In *Play with Moonlight*,
   pick your ultrawide: the stream should be **3440×1440**, not 2560×1072.
4. On the machine's desktop: *Settings → Display* should show 3440×1440.
5. Watch FPS (WoW Ctrl+R, Moonlight Ctrl+Alt+Shift+S): bigger screens cost more
   GPU time and data.

If setup stops at the driver stage, the activity log names the step; launch
again without Big screen. Details: `/var/log/cloudgaming-setup.log` and
`/var/log/nvidia-installer.log` on the machine.
