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

## 4. Watch it build  (≈15–30 min, first boot only)

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
| 75 / 85 | Starting Sunshine, waiting for healthy | 1–3 min |
| 100 | **Ready to stream** | |

Later starts skip all of this (about 1–2 minutes).

### If it fails, the error card says why. The GCP ones:

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

Machine card → **Play with Moonlight**:

1. **Pair Moonlight (one click)**: once per device.
2. Moonlight → the machine → **Desktop** or **Steam Big Picture** → sign in
   to Steam, install a small game first (e.g. a free one).
3. Press **Ctrl + Alt + Shift + S** in Moonlight for its stats overlay.

**Good numbers:** network latency ≈ the Recon estimate (±15 ms), decode time
< 5 ms, frame drops near 0, FPS steady at 60.
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
