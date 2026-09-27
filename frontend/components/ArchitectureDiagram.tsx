'use client';

/**
 * ============================================================================
 * frontend/components/ArchitectureDiagram.tsx — THE LIVE "WHAT RUNS WHERE" MAP
 * ============================================================================
 *
 * Draws every layer involved in playing a game through CloudGaming Hub, from
 * your screen down to the GPU, coloured by LIVE status:
 *
 *   YOU        your browser (this page)          + the Moonlight app
 *   VERCEL     the website (Next.js frontend)
 *   RAILWAY    the API server (Express) + its Postgres database
 *   CLOUD API  the cloud's control plane (e.g. Google's Compute Engine API)
 *   YOUR CLOUD ACCOUNT / REGION / ZONE
 *     network  virtual network + firewall + public IP
 *     machine  hypervisor → virtual machine → GPU → Ubuntu → desktop → Sunshine
 *     disk     the machine's virtual disk (games live here)
 *
 * Two paths matter and are drawn differently:
 *   CONTROL PATH (cyan): browser → Vercel → Railway → cloud API → machine.
 *     Used to launch/stop/delete. Slow is fine.
 *   STREAM PATH (lime): Moonlight ⇄ Sunshine on the machine, DIRECTLY over
 *     the internet. Vercel and Railway are NOT in the video path — that's
 *     why streaming is fast and doesn't cost Railway bandwidth.
 *
 * Click any box for a plain-English explanation of what it is, how it works,
 * who controls it, and what it costs.
 *
 * Props:
 *   machine  (optional) a machine row — shows ITS real resources and state.
 *            Without it, a generic map for the chosen `provider` is shown.
 *   provider which cloud to draw when there's no machine ('gcp' default).
 *   setupStage (optional) latest on-machine setup stage, to colour the
 *            software layers.
 * ============================================================================
 */

import { useEffect, useState } from 'react';
import { apiUrl } from '@/lib/api';

type Health = 'ok' | 'bad' | 'busy' | 'idle' | 'unknown';

interface MachineLike {
  id: string;
  provider: string;
  region: string;
  instance_type: string;
  instance_id: string;
  status: string;
  ip_address?: string | null;
  disk_size_gb?: number | null;
  spot?: boolean;
}

interface SystemStatus {
  database: { connected: boolean; latencyMs?: number };
  providers: Record<string, { connected: boolean; latencyMs?: number }>;
}

// ---------------------------------------------------------------------------
// Per-cloud vocabulary: what each layer is called on each cloud
// ---------------------------------------------------------------------------
interface CloudTerms {
  name: string;
  api: string;             // the control-plane API
  account: string;         // what a "space you own" is called
  network: string;         // virtual network pieces we create/use
  firewall: string;
  hypervisor: string;      // what actually runs the VM
  disk: string;
  ip: string;
  locationUnit: string;    // zone / availability zone / availability domain
  gpuAttach: string;       // how the GPU reaches the VM
}

const TERMS: Record<string, CloudTerms> = {
  gcp: {
    name: 'Google Cloud', api: 'Compute Engine API (compute.googleapis.com)', account: 'Project',
    network: 'VPC network "default" (auto subnets)', firewall: 'Firewall rule "cloudgaming-sunshine" (applies to machines tagged with it)',
    hypervisor: 'KVM-based hypervisor on a Google host', disk: 'Persistent Disk (pd-balanced), network-attached',
    ip: 'Ephemeral external IP (can change on stop/start)', locationUnit: 'Zone', gpuAttach: 'PCIe passthrough — the VM gets the whole NVIDIA GPU',
  },
  aws: {
    name: 'AWS', api: 'EC2 API (ec2.<region>.amazonaws.com)', account: 'Account',
    network: 'Default VPC + a default subnet per availability zone', firewall: 'Security group "cloudgaming-sunshine"',
    hypervisor: 'AWS Nitro hypervisor (dedicated Nitro cards handle network & disk)', disk: 'EBS gp3 volume (encrypted), network-attached',
    ip: 'Public IPv4 (changes on stop/start)', locationUnit: 'Availability zone', gpuAttach: 'PCIe passthrough — the VM gets the whole NVIDIA GPU',
  },
  azure: {
    name: 'Azure', api: 'Azure Resource Manager (management.azure.com)', account: 'Subscription → resource group',
    network: 'Virtual network + subnet + network interface (NIC)', firewall: 'Network security group (NSG)',
    hypervisor: 'Azure Hypervisor (Hyper-V based)', disk: 'Managed disk (SSD)', ip: 'Public IP address resource', locationUnit: 'Region',
    gpuAttach: 'Discrete Device Assignment (PCIe passthrough) of the NVIDIA GPU',
  },
  oracle: {
    name: 'Oracle Cloud', api: 'OCI Core Services API (iaas.<region>.oraclecloud.com)', account: 'Tenancy → compartment',
    network: 'VCN + public subnet + internet gateway + route table', firewall: 'Security list (plus the VM\'s own iptables)',
    hypervisor: 'KVM-based hypervisor on an OCI host', disk: 'Boot volume (block storage), network-attached', ip: 'Public IP',
    locationUnit: 'Availability domain', gpuAttach: 'PCIe passthrough — the VM gets the whole NVIDIA GPU',
  },
};

// ---------------------------------------------------------------------------
// Explanations shown when a box is clicked
// ---------------------------------------------------------------------------
interface NodeInfo { title: string; what: string; how: string; control: string; cost: string }

function explain(key: string, t: CloudTerms, m?: MachineLike): NodeInfo {
  const where = m ? `${m.region}` : 'the region you choose';
  const lib: Record<string, NodeInfo> = {
    browser: {
      title: 'Your browser (this page)',
      what: 'The CloudGaming Hub website running on your computer or phone.',
      how: 'It downloads the site from Vercel, then talks to the Railway API with your sign-in token (JSON over HTTPS). It never talks to the cloud directly and never holds your cloud keys after you save them.',
      control: 'You.', cost: 'Free.',
    },
    moonlight: {
      title: 'Moonlight (the app you play on)',
      what: 'A free game-streaming client for PC, Mac, phone, TV. It shows the video from the machine and sends your controller/keyboard input back.',
      how: 'It connects DIRECTLY to Sunshine on the machine\'s public IP (UDP ports 47998–48010 for video/audio, TCP 47984/47989/48010 for control). Vercel and Railway are not involved in the stream at all — that\'s what keeps lag low.',
      control: 'You.', cost: 'Free — but the video leaving the cloud is billed by the cloud as "egress".',
    },
    vercel: {
      title: 'Vercel — the website host',
      what: 'Serves this Next.js frontend from a global CDN (copies of the site close to every visitor).',
      how: 'Each push to GitHub builds the site; pages are static files plus a tiny server route (/api/build-info). NEXT_PUBLIC_API_URL is baked in at build time and tells the pages where the Railway API is. No secrets live here.',
      control: 'The app owner (Vercel project).', cost: 'Free tier / Vercel plan — not per game session.',
    },
    railway: {
      title: 'Railway — the API server',
      what: 'A container running the Express backend (Node.js). It checks sign-ins, stores encrypted cloud keys, and orchestrates every cloud action.',
      how: 'Railway builds the backend from GitHub into a container and runs it on its own virtual machines. On start it runs database migrations. When you press Launch, it decrypts YOUR key in memory, calls the cloud\'s API on your behalf, and writes a live log you see in the console. Background jobs re-check machine states every 5 minutes.',
      control: 'The app owner (Railway project + variables like JWT_SECRET, CREDENTIALS_ENCRYPTION_KEY).', cost: 'Railway plan — small, fixed.',
    },
    postgres: {
      title: 'Postgres database (on Railway)',
      what: 'Where accounts, machines, the activity log and your ENCRYPTED cloud keys are stored.',
      how: 'Only the API can reach it (private Railway network). Cloud keys are encrypted with AES-256-GCM before they arrive here; the master key lives in a Railway variable, not in the database — so a copy of the database alone reveals nothing.',
      control: 'The app owner.', cost: 'Part of the Railway plan.',
    },
    cloudapi: {
      title: `${t.name} control plane — ${t.api}`,
      what: `The ${t.name} service that creates, starts, stops and deletes resources in your ${t.account.toLowerCase()}.`,
      how: 'Every request is signed with the limited-access key you added. The cloud checks that key\'s permissions and your quotas (e.g. GPU limits), then schedules the work onto its hardware. Most actions are "long-running operations" the backend waits on.',
      control: `${t.name} runs it; your key decides what CloudGaming Hub may do in your ${t.account.toLowerCase()}.`, cost: 'API calls are free (AWS Cost Explorer queries are $0.01 each).',
    },
    account: {
      title: `Your ${t.name} ${t.account.toLowerCase()}`,
      what: `The isolated space in ${t.name} that you own and that pays the bill. Everything below lives inside it.`,
      how: `Machines are created here — not in the app owner's account — so you can see and control them directly in the ${t.name} console too.`,
      control: 'You.', cost: `Everything below is billed to you by ${t.name}.`,
    },
    network: {
      title: `Network — ${t.network}`,
      what: 'A private, software-defined network in your account that the machine plugs into.',
      how: `${t.firewall} only lets in the streaming ports Sunshine/Moonlight need. The machine also gets a public address: ${t.ip}. There\'s no SSH port opened by the app.`,
      control: 'Created/used by the app in your account; editable by you in the console.', cost: 'Usually free; public IPv4 addresses cost ~$0.005/hour on some clouds. Streamed video out is "egress" (~$0.09–0.12/GB).',
    },
    hypervisor: {
      title: `Physical host + ${t.hypervisor}`,
      what: `A real server in a ${t.name} datacenter in ${where}, shared between customers and split into virtual machines by a hypervisor.`,
      how: `The hypervisor gives your VM its own slice of CPU and memory, and hands it a whole physical NVIDIA GPU via ${t.gpuAttach}. That is why the GPU performs like a local card.`,
      control: t.name, cost: 'Included in the machine\'s hourly price.',
    },
    vm: {
      title: `Your virtual machine${m ? ` (${m.instance_type})` : ''}`,
      what: 'A GPU computer rented by the hour. It runs Ubuntu 22.04.',
      how: 'On first boot, our setup script installs the NVIDIA driver (then reboots once), a virtual screen (Xorg with no monitor attached), a light desktop, Sunshine and Steam. It prints progress to the serial console, which the app reads to show the setup bar.',
      control: 'You (it\'s in your account). The app starts/stops/deletes it with your key.', cost: `The hourly price while running${m?.spot ? ' (spot — cheaper but can be reclaimed)' : ''}. Stopped = no compute charge.`,
    },
    gpu: {
      title: 'NVIDIA GPU',
      what: 'Renders the game AND encodes the video (NVENC hardware encoder), so the CPU isn\'t the bottleneck.',
      how: 'Sunshine captures the virtual screen and has the GPU encode each frame to H.264/H.265 in a few milliseconds.',
      control: t.name + ' hardware, used exclusively by your VM.', cost: 'Most of the hourly price.',
    },
    sunshine: {
      title: 'Sunshine (streaming server) + desktop + Steam',
      what: 'Sunshine streams the machine\'s screen to Moonlight and passes your input back. Steam installs and runs your games.',
      how: 'Sunshine\'s web page (https://<ip>:47990, login shown on the machine card) is used once to pair Moonlight with a PIN. After that, Moonlight connects directly.',
      control: 'You.', cost: 'Free software.',
    },
    disk: {
      title: `Disk — ${t.disk}`,
      what: `The machine\'s hard drive${m?.disk_size_gb ? ` (${m.disk_size_gb} GB)` : ''}: Ubuntu, drivers, Steam and your installed games.`,
      how: 'It\'s network storage, separate from the physical host — so stopping the machine keeps it, and it can be snapshotted (a backup you can restore later).',
      control: 'You.', cost: 'Charged per GB per month even while the machine is stopped. Deleting the machine deletes the disk.',
    },
  };
  return lib[key];
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

const DOT: Record<Health, string> = {
  ok: 'bg-neon-lime shadow-[0_0_6px_rgba(143,214,148,0.7)]',
  bad: 'bg-[#e5484d] shadow-[0_0_6px_rgba(229,72,77,0.7)]',
  busy: 'bg-neon-amber animate-pulse',
  idle: 'bg-slate-500',
  unknown: 'bg-slate-700',
};

function Node({
  id, label, sub, health, active, onSelect, className = '',
}: {
  id: string; label: string; sub?: string; health: Health; active: boolean; onSelect: (id: string) => void; className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={`text-left rounded border px-3 py-2 transition w-full ${
        active ? 'border-neon-cyan bg-neon-cyan/[0.07]' : 'border-white/10 bg-white/[0.02] hover:border-white/30'
      } ${className}`}
    >
      <span className="flex items-center gap-2">
        <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${DOT[health]}`} />
        <span className="text-[0.78rem] text-slate-100 font-medium">{label}</span>
      </span>
      {sub && <span className="block text-[0.68rem] text-slate-500 mt-0.5 leading-snug break-words">{sub}</span>}
    </button>
  );
}

function Layer({ name, note, children, tone = 'border-white/10' }: { name: string; note: string; children: React.ReactNode; tone?: string }) {
  return (
    <div className={`rounded-md border ${tone} p-3`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <span className="label">{name}</span>
        <span className="text-[0.66rem] text-slate-500">{note}</span>
      </div>
      {children}
    </div>
  );
}

/** A vertical connector between layers, labelled with what flows over it. */
function Link({ label, kind }: { label: string; kind: 'control' | 'stream' | 'both' }) {
  const colour = kind === 'stream' ? 'text-neon-lime' : kind === 'both' ? 'text-slate-400' : 'text-neon-cyan';
  return (
    <div className={`flex items-center gap-2 pl-4 py-1 text-[0.66rem] ${colour}`}>
      <span className="font-mono">│</span>
      <span>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The diagram
// ---------------------------------------------------------------------------

export default function ArchitectureDiagram({
  machine, provider = 'gcp', setupStage,
}: {
  machine?: MachineLike | null;
  provider?: string;
  setupStage?: { key: string; percent: number; message: string } | null;
}) {
  const cloud = machine?.provider || provider;
  const t = TERMS[cloud] || TERMS.gcp;
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<string>('vm');

  // Live health of Railway, Postgres and the cloud API (public endpoint).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(apiUrl('/status'), { cache: 'no-store' });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (!cancelled) { setStatus(data); setBackendUp(true); }
      } catch {
        if (!cancelled) { setStatus(null); setBackendUp(false); }
      }
    };
    load();
    const timer = setInterval(load, 20000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // Map machine / setup states onto colours.
  const ms = machine?.status;
  const vmHealth: Health = !machine ? 'unknown'
    : ms === 'running' ? 'ok'
    : ['creating', 'starting', 'stopping', 'deleting'].includes(ms || '') ? 'busy'
    : ms === 'stopped' ? 'idle' : 'bad';
  const softwareHealth: Health = !machine || machine.instance_id.startsWith('pending:') ? 'unknown'
    : ms !== 'running' ? (vmHealth === 'bad' ? 'bad' : 'unknown')
    : !setupStage ? 'busy'
    : setupStage.key === 'ready' ? 'ok'
    : setupStage.key === 'failed' ? 'bad' : 'busy';
  const cloudApi = status?.providers?.[cloud];

  // Only machines that actually exist at the cloud have a real id. Ours is
  // "<location>/<name>" — the location is a ZONE only on Google Cloud (on AWS
  // it's the region, on Azure the resource group, on Oracle the region).
  const created = !!machine && !machine.instance_id.startsWith('pending:');
  const [loc, rawName] = created ? machine!.instance_id.split('/') : ['', ''];
  const zone = cloud === 'gcp' ? loc : '';
  const name = rawName && rawName.length > 24 ? `…${rawName.slice(-12)}` : rawName;
  const info = explain(selected, t, machine || undefined);

  return (
    <div className="grid lg:grid-cols-[1fr,320px] gap-4">
      <div className="space-y-0">
        <Layer name="You" note="your devices">
          <div className="grid sm:grid-cols-2 gap-2">
            <Node id="browser" label="Browser — this page" sub="controls everything" health="ok" active={selected === 'browser'} onSelect={setSelected} />
            <Node id="moonlight" label="Moonlight app" sub="plays the stream" health={softwareHealth === 'ok' ? 'ok' : 'unknown'} active={selected === 'moonlight'} onSelect={setSelected} />
          </div>
        </Layer>
        <Link kind="control" label="HTTPS: page load (Vercel) · JSON API calls with your sign-in token (Railway)" />
        <Layer name="Vercel" note="website hosting · global CDN" tone="border-white/10">
          <Node id="vercel" label="Next.js frontend" sub="static pages + /api/build-info" health="ok" active={selected === 'vercel'} onSelect={setSelected} />
        </Layer>
        <Link kind="control" label="HTTPS → NEXT_PUBLIC_API_URL" />
        <Layer name="Railway" note="app platform · containers">
          <div className="grid sm:grid-cols-2 gap-2">
            <Node id="railway" label="Express API container" sub="auth · encrypted key vault · orchestration · jobs"
              health={backendUp === null ? 'unknown' : backendUp ? 'ok' : 'bad'} active={selected === 'railway'} onSelect={setSelected} />
            <Node id="postgres" label="Postgres database" sub={status?.database.latencyMs !== undefined ? `${status.database.latencyMs} ms` : 'accounts · machines · activity log'}
              health={!status ? 'unknown' : status.database.connected ? 'ok' : 'bad'} active={selected === 'postgres'} onSelect={setSelected} />
          </div>
        </Layer>
        <Link kind="control" label={`HTTPS API calls signed with YOUR ${t.name} key (decrypted in memory only)`} />
        <Layer name={`${t.name} — control plane`} note="the cloud's management API">
          <Node id="cloudapi" label={t.api} sub={cloudApi?.latencyMs !== undefined ? `reachable · ${cloudApi.latencyMs} ms` : 'create · start · stop · delete · snapshot'}
            health={!status ? 'unknown' : cloudApi?.connected ? 'ok' : 'bad'} active={selected === 'cloudapi'} onSelect={setSelected} />
        </Layer>
        <Link kind="control" label="schedules resources onto physical hardware" />
        <Layer name={`Your ${t.account.toLowerCase()} · ${machine ? machine.region : 'region'}${zone ? ` · ${t.locationUnit.toLowerCase()} ${zone}` : ''}`} note="billed to you" tone="border-neon-cyan/25">
          <div className="space-y-2">
            <Node id="account" label={`${t.account}`} sub="everything below lives here" health={machine ? 'ok' : 'unknown'} active={selected === 'account'} onSelect={setSelected} />
            <Node id="network" label="Network + firewall + public IP" sub={`${t.firewall}${machine?.ip_address ? ` · IP ${machine.ip_address}` : ''}`}
              health={machine?.ip_address ? 'ok' : vmHealth === 'busy' ? 'busy' : 'unknown'} active={selected === 'network'} onSelect={setSelected} />
            <div className="rounded border border-white/10 p-2 space-y-2">
              <Node id="hypervisor" label="Physical host · hypervisor" sub={t.hypervisor} health={created ? vmHealth : 'unknown'} active={selected === 'hypervisor'} onSelect={setSelected} />
              <div className="pl-3 border-l border-white/10 space-y-2">
                <Node id="vm" label={`Virtual machine${name ? ` · ${name}` : ''}`} sub={machine ? `${machine.instance_type} · ${machine.status}${machine.spot ? ' · spot' : ''}` : 'Ubuntu 22.04'}
                  health={vmHealth} active={selected === 'vm'} onSelect={setSelected} />
                <div className="pl-3 border-l border-white/10 grid sm:grid-cols-2 gap-2">
                  <Node id="gpu" label="NVIDIA GPU" sub={t.gpuAttach} health={!created ? 'unknown' : softwareHealth === 'ok' ? 'ok' : vmHealth === 'ok' ? 'busy' : vmHealth} active={selected === 'gpu'} onSelect={setSelected} />
                  <Node id="sunshine" label="Ubuntu · desktop · Sunshine · Steam"
                    sub={setupStage ? `${setupStage.percent}% · ${setupStage.message}` : ms === 'running' ? 'setup status unknown yet' : created ? 'installed by the setup script' : 'not created (the launch failed)'}
                    health={softwareHealth} active={selected === 'sunshine'} onSelect={setSelected} />
                </div>
              </div>
            </div>
            <Node id="disk" label="Disk" sub={`${t.disk}${machine?.disk_size_gb ? ` · ${machine.disk_size_gb} GB` : ''}`}
              health={machine ? (vmHealth === 'bad' ? 'unknown' : 'ok') : 'unknown'} active={selected === 'disk'} onSelect={setSelected} />
          </div>
        </Layer>
        <div className="mt-2 rounded border border-neon-lime/30 bg-neon-lime/[0.04] px-3 py-2 text-[0.7rem] text-neon-lime">
          ⇅ Game stream: Moonlight ⇄ Sunshine directly over the internet (UDP) — it does NOT pass through Vercel or Railway.
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-[0.64rem] text-slate-500">
          {(['ok', 'busy', 'idle', 'bad', 'unknown'] as Health[]).map((h) => (
            <span key={h} className="inline-flex items-center gap-1.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${DOT[h]}`} />
              {{ ok: 'working', busy: 'in progress', idle: 'stopped', bad: 'problem', unknown: 'not known / n/a' }[h]}
            </span>
          ))}
        </div>
      </div>

      {/* Explanation panel for the selected box */}
      {info && (
        <aside className="rounded-md border border-neon-cyan/25 bg-cyber-panel/60 p-4 text-sm space-y-3 lg:sticky lg:top-28 self-start">
          <h4 className="text-slate-100 font-semibold leading-snug">{info.title}</h4>
          <div><p className="label mb-1">What it is</p><p className="text-slate-300 leading-relaxed">{info.what}</p></div>
          <div><p className="label mb-1">How it works</p><p className="text-slate-300 leading-relaxed">{info.how}</p></div>
          <div><p className="label mb-1">Who controls it</p><p className="text-slate-300 leading-relaxed">{info.control}</p></div>
          <div><p className="label mb-1">What it costs</p><p className="text-slate-300 leading-relaxed">{info.cost}</p></div>
          <p className="text-[0.66rem] text-slate-500">Click any box on the left to learn about it.</p>
        </aside>
      )}
    </div>
  );
}
