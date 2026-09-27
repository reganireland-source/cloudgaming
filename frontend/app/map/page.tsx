'use client';

/**
 * ============================================================================
 * frontend/app/map/page.tsx — INFRASTRUCTURE MAP (/map)
 * ============================================================================
 *
 * Everything you've deployed, on a world map, by location and status, colour
 * coded (and shape coded) by cloud. Refreshes every 10 seconds.
 *
 * LAYOUT
 *   • Cost overlay: running now ($/hour), standing ($/month for disks,
 *     snapshots and IPs that bill even when machines are stopped), and
 *     orphans (things still billing but attached to nothing).
 *   • Per-cloud strip: resources, machines, spend for each cloud.
 *   • The map (components/InfraMap.tsx): one stacked marker per cloud +
 *     region, status rings, orphan badges, faint available regions, our
 *     platform (Railway), you + ping rings, zoom & pan.
 *   • Detail panel for the clicked marker: every resource there with its
 *     status and cost, console links, and Start / Stop / Sync / Connect for
 *     machines (running live, with the operation log).
 *   • Orphans list and a full table (the map's data in text form).
 *
 * DATA
 *   GET /api/inventory   your deployed resources, live from each cloud (cached 60 s)
 *   GET /api/status/catalog   public: all regions, prices, where the backend runs
 *
 * YOUR LOCATION, best source first:
 *   1. a spot you chose (browser GPS via "Use precise location", or a map
 *      click) — remembered in this browser;
 *   2. your IP address, looked up by Vercel's edge (GET /api/geo on the
 *      frontend — no third-party service; usually the right city);
 *   3. a rough guess from your time zone.
 * The label under the map always says which one is in use.
 * ============================================================================
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { apiUrl } from '@/lib/api';
import { apiFetch, ApiError, type FriendlyError } from '@/lib/auth';
import { useAuth } from '@/components/AuthProvider';
import CloudLogo from '@/components/CloudLogo';
import InfraMap, { CLOUD_STYLE, STATUS_STYLE, estimatePingMs, type AvailableRegion, type GroupStatus, type LatLng, type MarkerGroup } from '@/components/InfraMap';
import OperationConsole from '@/components/OperationConsole';
import FriendlyErrorCard from '@/components/FriendlyErrorCard';
import MachineConnectionPanel from '@/components/MachineConnectionPanel';

interface Item {
  provider: string; type: string; id: string; name: string; region: string; zone?: string; status: string;
  instanceId?: string; attachedTo?: string; sizeGb?: number; hourlyCost?: number; monthlyCost?: number;
  orphan?: boolean; orphanReason?: string; consoleUrl?: string; createdAt?: string; machineId?: string; source: 'cloud' | 'app';
}
interface Inventory {
  generatedAt: string;
  clouds: string[];
  items: Item[];
  errors: Array<{ provider: string; error: FriendlyError }>;
  totals: { runningMachines: number; hourly: number; monthlyStanding: number; orphans: number; orphanMonthly: number; orphanHourly: number };
  byCloud: Record<string, { label: string; items: number; machines: number; running: number; hourly: number; monthly: number }>;
}
interface Catalog {
  providers: Array<{ provider: string; label: string; regions: Array<{ id: string; name: string; lat: number; lng: number; gpus: string[]; cheapest: { onDemand: number } | null }> }>;
  backendRegion: string | null;
}

const RAILWAY_REGIONS = [
  { prefix: 'us-west', label: 'US West (California)', lat: 37.4, lng: -122.0 },
  { prefix: 'us-east', label: 'US East (Virginia)', lat: 39.0, lng: -77.5 },
  { prefix: 'europe-west', label: 'EU West (Amsterdam)', lat: 52.4, lng: 4.9 },
  { prefix: 'asia-southeast', label: 'Southeast Asia (Singapore)', lat: 1.35, lng: 103.8 },
];
const LOCATION_KEY = 'cg_location';
const TYPE_LABEL: Record<string, string> = {
  vm: 'Machine', disk: 'Disk', snapshot: 'Snapshot', network: 'Network', subnet: 'Subnet', firewall: 'Firewall',
  'public-ip': 'Public IP', nic: 'Network card', gateway: 'Internet gateway', 'route-table': 'Route table', 'resource-group': 'Resource group', other: 'Other',
};

/** Machine status words (they vary by cloud) → one of five map states. */
function vmState(status: string): GroupStatus {
  const s = status.toLowerCase();
  if (s === 'running') return 'running';
  if (/fail|missing|unknown|error/.test(s)) return 'problem';
  if (/still billed|creat|start|stopp|delet|provision|staging|deallocating|pending|repair|suspending/.test(s)) return 'changing';
  if (/stopped|deallocated|terminated|suspended/.test(s)) return 'stopped';
  return 'changing';
}
const STATE_RANK: GroupStatus[] = ['problem', 'changing', 'running', 'stopped', 'resources'];

function ShapeIcon({ provider, size = 14 }: { provider: string; size?: number }) {
  return <CloudLogo provider={provider} size={size} className="align-[-2px]" />;
}

function StatusChip({ status }: { status: string }) {
  const st = STATUS_STYLE[vmState(status)];
  return (
    <span className="inline-flex items-center gap-1 text-[0.66rem] uppercase tracking-label rounded border px-1.5 py-px" style={{ borderColor: `${st.color}80`, color: '#e2e8f0' }}>
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: st.color }} />{status}
    </span>
  );
}

function Tile({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`rounded border px-3 py-2.5 ${warn ? 'border-neon-pink/40 bg-neon-pink/[0.04]' : 'border-white/10 bg-white/[0.02]'}`}>
      <p className="label">{label}</p>
      <p className="text-lg text-slate-100 tabular-nums mt-0.5">{value}</p>
      {sub && <p className="text-[0.68rem] text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function InfrastructureMapPage() {
  const { user, loading: authLoading } = useAuth();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Where you are, and how we know (see header).
  const [location, setLocation] = useState<(LatLng & { source: 'manual' | 'gps' | 'ip' | 'timezone'; label?: string; approximate?: boolean }) | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The detail panel sits below the full-width map: when a marker is
  // picked, scroll just enough to bring it into view.
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selected]);
  const [visible, setVisible] = useState<Set<string>>(new Set(['gcp', 'aws', 'azure', 'oracle']));
  const [layers, setLayers] = useState({ available: true, rings: true, paths: true });
  const [ops, setOps] = useState<Record<string, string>>({});        // machineId → running operation id
  const [connectFor, setConnectFor] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  // ---- Location (browser only) ----
  useEffect(() => {
    // 1. A spot you chose earlier?
    try {
      const saved = localStorage.getItem(LOCATION_KEY);
      if (saved) { const loc = JSON.parse(saved); setLocation({ source: 'manual', ...loc }); return; }
    } catch { /* storage blocked */ }
    // 3. (placeholder until the IP lookup answers) time-zone guess
    setLocation({ lat: 20, lng: Math.max(-179, Math.min(179, (-new Date().getTimezoneOffset() / 60) * 15)), source: 'timezone', approximate: true });
    // 2. Your IP address, via Vercel's edge (same-site route, see app/api/geo/route.ts).
    fetch('/api/geo', { cache: 'no-store' })
      .then((r) => r.json())
      .then((g) => {
        if (g?.available) {
          const place = [g.city, g.country].filter(Boolean).join(', ');
          setLocation((cur) => (cur && (cur.source === 'manual' || cur.source === 'gps')) ? cur
            : { lat: g.lat, lng: g.lng, source: 'ip', label: place || undefined, approximate: true });
        }
      })
      .catch(() => { /* keep the time-zone guess */ });
  }, []);
  const saveLocation = (loc: LatLng, source: 'manual' | 'gps' = 'manual') => {
    const next = { lat: loc.lat, lng: loc.lng, source, label: source === 'gps' ? 'your device' : 'chosen on the map' };
    setLocation(next);
    try { localStorage.setItem(LOCATION_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const forgetLocation = () => {
    try { localStorage.removeItem(LOCATION_KEY); } catch { /* ignore */ }
    window.location.reload(); // simplest way to re-run the IP lookup
  };
  const useMyLocation = () => navigator.geolocation?.getCurrentPosition(
    (p) => saveLocation({ lat: p.coords.latitude, lng: p.coords.longitude }, 'gps'),
    () => setLoadError('Location permission denied — click on the map to set where you are.'),
  );

  // ---- Data ----
  useEffect(() => {
    fetch(apiUrl('/status/catalog'), { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setCatalog)
      .catch((e) => setLoadError(e.message === 'HTTP 404' ? 'The backend is an older version — redeploy it on Railway.' : `Couldn't load regions (${e.message}).`));
  }, []);

  const loadInventory = useCallback(async (refresh = false) => {
    if (!user) return;
    if (refresh) setRefreshing(true);
    try {
      setInventory(await apiFetch<Inventory>(`/inventory${refresh ? '?refresh=true' : ''}`));
    } catch (e) {
      setLoadError((e as ApiError).message);
    } finally {
      setRefreshing(false);
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    loadInventory();
    const timer = setInterval(() => loadInventory(), 10000);
    return () => clearInterval(timer);
  }, [user, loadInventory]);

  // ---- Derived: region lookup, marker groups ----
  const regionInfo = useMemo(() => {
    const map = new Map<string, { name: string; lat: number; lng: number }>();
    for (const p of catalog?.providers || []) for (const r of p.regions) map.set(`${p.provider}:${r.id}`, r);
    return map;
  }, [catalog]);

  const items = useMemo(() => (inventory?.items || []).filter((i) => visible.has(i.provider)), [inventory, visible]);

  const groups: MarkerGroup[] = useMemo(() => {
    const byKey = new Map<string, Item[]>();
    for (const it of items) {
      if (!regionInfo.has(`${it.provider}:${it.region}`)) continue; // 'global' etc. are listed, not mapped
      const key = `${it.provider}:${it.region}`;
      byKey.set(key, [...(byKey.get(key) || []), it]);
    }
    return Array.from(byKey.entries()).map(([key, list]) => {
      const [provider, region] = key.split(':');
      const info = regionInfo.get(key)!;
      const vms = list.filter((i) => i.type === 'vm');
      const states = vms.map((v) => vmState(v.status));
      const status: GroupStatus = vms.length ? STATE_RANK.find((s) => states.includes(s)) || 'stopped' : 'resources';
      return {
        key, provider, region, regionName: info.name, lat: info.lat, lng: info.lng,
        count: list.length, machines: vms.length, status,
        orphans: list.filter((i) => i.orphan).length,
        hourly: vms.filter((v) => v.status === 'running').reduce((s, v) => s + (v.hourlyCost || 0), 0),
        monthly: list.reduce((s, i) => s + (i.monthlyCost || 0), 0),
      };
    });
  }, [items, regionInfo]);

  const available: AvailableRegion[] = useMemo(() => (catalog?.providers || [])
    .filter((p) => visible.has(p.provider))
    .flatMap((p) => p.regions.map((r) => ({ provider: p.provider, id: r.id, name: r.name, lat: r.lat, lng: r.lng, fromPrice: r.cheapest?.onDemand }))), [catalog, visible]);

  const backend = useMemo(() => {
    const code = catalog?.backendRegion || '';
    const m = RAILWAY_REGIONS.find((r) => code.startsWith(r.prefix));
    return m ? { lat: m.lat, lng: m.lng, label: `${m.label} · ${code}` } : null;
  }, [catalog]);

  const selectedGroup = groups.find((g) => g.key === selected) || null;
  const selectedItems = selectedGroup ? items.filter((i) => `${i.provider}:${i.region}` === selectedGroup.key) : [];
  const unmapped = items.filter((i) => !regionInfo.has(`${i.provider}:${i.region}`));
  const orphans = items.filter((i) => i.orphan);

  // ---- Machine actions ----
  const act = async (machineId: string, action: 'start' | 'stop' | 'sync') => {
    setActionError(null);
    try {
      const res = await apiFetch<{ operationId: string }>(`/machines/${machineId}/${action}`, { method: 'POST', body: {} });
      setOps((o) => ({ ...o, [machineId]: res.operationId }));
    } catch (e) {
      setActionError(e as ApiError);
    }
  };

  const toggleCloud = (p: string) => setVisible((v) => { const n = new Set(v); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  // ---- Render ----
  return (
    // Below lg (phones, square screens) the map moves up to sit right under
    // the title — the tiles, filters and legend follow it — so it is on
    // screen without scrolling. -order-N only applies below lg.
    <div className="flex flex-col gap-4 sm:gap-5">
      <div className="-order-2 lg:order-none flex flex-col md:flex-row md:items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-xl font-bold neon-text mb-1 font-mono">[ INFRASTRUCTURE_MAP ]</h1>
          <p className="text-sm text-slate-400 max-w-2xl short:hidden">Everything you&apos;ve deployed, by location and status, colour-coded by cloud. Updates every 10 seconds.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {user && (
            <button type="button" onClick={() => loadInventory(true)} disabled={refreshing} className="btn-neon text-xs disabled:opacity-50">
              {refreshing ? 'Asking the clouds…' : '↻ Refresh from clouds'}
            </button>
          )}
          <button type="button" onClick={useMyLocation} className="btn-neon text-xs">◎ Use precise location</button>
        </div>
      </div>

      {loadError && <p className="text-sm text-neon-amber">⚠ {loadError}</p>}
      {!authLoading && !user && (
        <div className="rounded border border-white/10 p-4 text-sm text-slate-300">
          Showing available regions only. <Link href="/login?next=/map" className="text-neon-cyan hover:underline">Sign in</Link> to see your deployed infrastructure.
        </div>
      )}

      {/* ---- Cost overlay ---- */}
      {inventory && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Tile label="Running now" value={`$${inventory.totals.hourly.toFixed(2)}/h`} sub={`${inventory.totals.runningMachines} machine${inventory.totals.runningMachines === 1 ? '' : 's'} running`} />
          <Tile label="Standing cost" value={`$${inventory.totals.monthlyStanding.toFixed(2)}/mo`} sub="disks, snapshots, IPs — billed even when stopped" />
          <Tile label="Resources" value={`${inventory.items.length}`} sub={`across ${inventory.clouds.length} cloud${inventory.clouds.length === 1 ? '' : 's'}`} />
          <Tile label="Orphans" value={`${inventory.totals.orphans}`} warn={inventory.totals.orphans > 0}
            sub={inventory.totals.orphans ? `≈$${inventory.totals.orphanMonthly.toFixed(2)}/mo${inventory.totals.orphanHourly ? ` + $${inventory.totals.orphanHourly.toFixed(2)}/h` : ''} wasted` : 'nothing left behind'} />
        </div>
      )}

      {/* ---- Filters (per cloud, with its totals) + layers ---- */}
      <div className="flex flex-wrap items-center gap-2">
        {Object.entries(CLOUD_STYLE).map(([key, s]) => {
          const t = inventory?.byCloud[key];
          return (
            <button key={key} type="button" onClick={() => toggleCloud(key)} aria-pressed={visible.has(key)}
              className={`inline-flex items-center gap-1.5 text-xs rounded border px-2.5 py-1 ${visible.has(key) ? 'border-white/25 text-slate-200' : 'border-white/10 text-slate-500 line-through'}`}>
              <ShapeIcon provider={key} /> {s.label}
              {t && <span className="text-slate-400 tabular-nums">· {t.items} · ${t.hourly.toFixed(2)}/h · ${t.monthly.toFixed(0)}/mo</span>}
            </button>
          );
        })}
        <span className="mx-1 h-4 w-px bg-white/10" />
        {([['available', 'Available regions'], ['rings', 'Ping rings'], ['paths', 'Paths']] as const).map(([k, label]) => (
          <label key={k} className="inline-flex items-center gap-1.5 text-xs text-slate-400">
            <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers((l) => ({ ...l, [k]: e.target.checked }))} /> {label}
          </label>
        ))}
      </div>

      {inventory?.errors.map((e) => (
        <details key={e.provider} className="rounded border border-neon-amber/30 px-3 py-2">
          <summary className="text-xs text-neon-amber cursor-pointer">⚠ Couldn&apos;t read {CLOUD_STYLE[e.provider]?.label || e.provider}: {e.error.title} (click for the fix)</summary>
          <div className="mt-2"><FriendlyErrorCard friendly={e.error} compact /></div>
        </details>
      ))}

      <div className="-order-1 lg:order-none space-y-3">
        {/* ---- Map: the full width of the page ---- */}
        <div className="neon-card rounded-lg border border-white/10 p-2">
            {catalog ? (
              <InfraMap groups={groups} available={available} user={location} backend={backend}
                userLabel={location?.source === 'ip' && location.label ? `You · ${location.label.split(',')[0]}` : 'You'}
                showAvailable={layers.available} showRings={layers.rings} showPaths={layers.paths}
                selectedKey={selected} onSelect={setSelected} onPickLocation={saveLocation} />
            ) : <p className="font-mono text-sm text-neon-cyan animate-pulse p-6">&gt; LOADING_MAP…</p>}
        </div>

        {/* ---- Below the map: details (left, wider) + legend ---- */}
        <div className="grid lg:grid-cols-[minmax(0,1fr),minmax(0,420px)] gap-4">
          <div className="lg:order-2 flex flex-wrap content-start gap-x-4 gap-y-1 text-[0.68rem] text-slate-400">
            {(Object.keys(STATUS_STYLE) as GroupStatus[]).map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><circle cx="7" cy="7" r="5" fill="none" stroke={STATUS_STYLE[k].color} strokeWidth="2" strokeDasharray={STATUS_STYLE[k].dashed ? '2 2' : undefined} /></svg>
                {STATUS_STYLE[k].label}
              </span>
            ))}
            <span>① count badge</span><span className="text-neon-pink">⚠ orphan</span>
            <span className="text-neon-lime">┈ stream</span><span className="text-neon-cyan">— control</span>
            <span>◇ Railway (API + DB) · Vercel serves the site from every edge</span>
            <span className="text-slate-400 w-full">
              📍 You: {location ? (
                <>
                  <span className="text-slate-200">{location.label || `${location.lat.toFixed(1)}°, ${location.lng.toFixed(1)}°`}</span>
                  {' — '}
                  {{ ip: 'from your IP address (approximate, city level)', gps: 'from your device (precise)', manual: 'chosen on the map', timezone: 'rough guess from your time zone' }[location.source]}
                  {(location.source === 'manual' || location.source === 'gps') && (
                    <button type="button" onClick={forgetLocation} className="ml-2 text-neon-cyan hover:underline">use IP location instead</button>
                  )}
                  {location.source !== 'gps' && <span className="text-slate-500"> · click the map to set it yourself</span>}
                </>
              ) : 'locating…'}
            </span>
          </div>

        {/* ---- Detail panel ---- */}
        <aside ref={detailRef} className="lg:order-1 rounded-lg border border-white/10 bg-cyber-panel/50 p-3 sm:p-4 space-y-3 self-start scroll-mt-3">
          {!selectedGroup ? (
            <>
              <p className="label">Details</p>
              <p className="text-sm text-slate-400">Click a marker to see what&apos;s deployed there and manage it.</p>
              {user && inventory && groups.length === 0 && (
                <p className="text-sm text-slate-400">Nothing deployed yet. <Link href="/machines" className="text-neon-cyan hover:underline">Launch a machine →</Link></p>
              )}
            </>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-slate-100 flex items-center gap-2"><ShapeIcon provider={selectedGroup.provider} /> {CLOUD_STYLE[selectedGroup.provider].label} · {selectedGroup.regionName}</p>
                  <p className="text-xs text-slate-500">{selectedGroup.region}{location ? ` · est. ping ~${estimatePingMs(location, selectedGroup)} ms` : ''}</p>
                </div>
                <button type="button" onClick={() => setSelected(null)} className="text-xs text-slate-400 hover:text-slate-100">✕</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Tile label="Running" value={`$${selectedGroup.hourly.toFixed(2)}/h`} />
                <Tile label="Standing" value={`$${selectedGroup.monthly.toFixed(2)}/mo`} />
              </div>
              {actionError && <FriendlyErrorCard message={actionError.message} tip={actionError.tip} friendly={actionError.friendly} />}
              <ul className="space-y-2">
                {selectedItems
                  .sort((a, b) => (a.type === 'vm' ? -1 : b.type === 'vm' ? 1 : a.type.localeCompare(b.type)))
                  .map((it) => (
                  <li key={`${it.provider}-${it.id}`} className={`rounded border p-2.5 ${it.orphan ? 'border-neon-pink/40' : 'border-white/10'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[0.66rem] uppercase tracking-label text-slate-500">{TYPE_LABEL[it.type] || it.type}{it.zone ? ` · ${it.zone}` : ''}</p>
                        <p className="text-xs text-slate-100 break-all">{it.name}</p>
                      </div>
                      <StatusChip status={it.status} />
                    </div>
                    <p className="text-[0.7rem] text-slate-400 mt-1 tabular-nums">
                      {it.hourlyCost ? `≈$${it.hourlyCost.toFixed(2)}/h while running` : ''}
                      {it.monthlyCost ? `${it.hourlyCost ? ' · ' : ''}≈$${it.monthlyCost.toFixed(2)}/mo` : ''}
                      {it.sizeGb ? ` · ${it.sizeGb} GB` : ''}
                      {!it.hourlyCost && !it.monthlyCost ? 'no charge' : ''}
                    </p>
                    {it.orphan && <p className="text-[0.7rem] text-neon-pink mt-1">⚠ {it.orphanReason}</p>}
                    {it.source === 'app' && (
                      <p className="text-[0.7rem] text-slate-500 mt-1">
                        {inventory?.errors.some((e) => e.provider === it.provider)
                          ? `Couldn't read ${CLOUD_STYLE[it.provider]?.label} just now — showing the app's own record.`
                          : !inventory?.clouds.includes(it.provider)
                          ? `No ${CLOUD_STYLE[it.provider]?.label} keys saved — showing the app's own record.`
                          : 'Known to the app only — not (yet) returned by the cloud.'}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2 mt-2">
                      {it.type === 'vm' && it.machineId && (
                        <>
                          {vmState(it.status) === 'stopped' && <button type="button" onClick={() => act(it.machineId!, 'start')} className="btn-neon-lime text-[0.7rem] py-0.5 px-2">Start</button>}
                          {it.status === 'running' && <button type="button" onClick={() => act(it.machineId!, 'stop')} className="btn-neon-pink text-[0.7rem] py-0.5 px-2">Stop</button>}
                          <button type="button" onClick={() => act(it.machineId!, 'sync')} className="btn-neon text-[0.7rem] py-0.5 px-2">Sync</button>
                          {it.status === 'running' && <button type="button" onClick={() => setConnectFor(connectFor === it.machineId ? null : it.machineId!)} className="btn-neon-magenta text-[0.7rem] py-0.5 px-2">Connect</button>}
                        </>
                      )}
                      {it.consoleUrl && <a href={it.consoleUrl} target="_blank" rel="noopener noreferrer" className="text-[0.7rem] text-neon-cyan hover:underline self-center">Open in console ↗</a>}
                    </div>
                    {it.machineId && ops[it.machineId] && (
                      <div className="mt-2"><OperationConsole operationId={ops[it.machineId]} height="max-h-40" onFinished={() => loadInventory(true)} /></div>
                    )}
                    {it.machineId && connectFor === it.machineId && (
                      <div className="mt-3"><MachineConnectionPanel machineId={it.machineId} status={it.status} /></div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Orphans across everything */}
          {orphans.length > 0 && (
            <div className="border-t border-white/5 pt-3">
              <p className="label text-neon-pink mb-2">⚠ Orphans — still billing</p>
              <ul className="space-y-1.5 text-xs">
                {orphans.map((o) => (
                  <li key={`${o.provider}-${o.id}`} className="flex items-start gap-2">
                    <ShapeIcon provider={o.provider} />
                    <span className="min-w-0">
                      <button type="button" className="text-slate-200 hover:underline text-left break-all" onClick={() => setSelected(`${o.provider}:${o.region}`)}>{TYPE_LABEL[o.type]} {o.name}</button>
                      <span className="block text-slate-500">{o.region} · {o.monthlyCost ? `$${o.monthlyCost.toFixed(2)}/mo` : o.hourlyCost ? `$${o.hourlyCost.toFixed(2)}/h` : 'no charge'} · {o.orphanReason}</span>
                      {o.consoleUrl && <a href={o.consoleUrl} target="_blank" rel="noopener noreferrer" className="text-neon-cyan hover:underline">Delete in console ↗</a>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {unmapped.length > 0 && (
            <div className="border-t border-white/5 pt-3">
              <p className="label mb-2">Global / not on the map</p>
              <ul className="space-y-1 text-xs text-slate-300">
                {unmapped.map((u) => <li key={`${u.provider}-${u.id}`}><ShapeIcon provider={u.provider} /> {TYPE_LABEL[u.type]} · {u.name} <span className="text-slate-500">({u.region}, {u.status})</span></li>)}
              </ul>
            </div>
          )}
        </aside>
        </div>
      </div>

      {/* ---- Table view (the same data as text) ---- */}
      {inventory && inventory.items.length > 0 && (
        <details className="neon-card rounded-lg border border-white/10 p-4">
          <summary className="label cursor-pointer">Table view — all {inventory.items.length} resources</summary>
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-slate-500">
                <th className="py-1 pr-3 font-normal">Cloud</th><th className="py-1 pr-3 font-normal">Region</th><th className="py-1 pr-3 font-normal">Type</th>
                <th className="py-1 pr-3 font-normal">Name</th><th className="py-1 pr-3 font-normal">Status</th><th className="py-1 pr-3 font-normal text-right">$/h</th><th className="py-1 font-normal text-right">$/mo</th>
              </tr></thead>
              <tbody>
                {inventory.items.map((i) => (
                  <tr key={`${i.provider}-${i.id}`} className="border-t border-white/5">
                    <td className="py-1 pr-3"><ShapeIcon provider={i.provider} /> {CLOUD_STYLE[i.provider]?.label}</td>
                    <td className="py-1 pr-3 text-slate-300">{i.region}{i.zone ? ` / ${i.zone}` : ''}</td>
                    <td className="py-1 pr-3 text-slate-300">{TYPE_LABEL[i.type] || i.type}</td>
                    <td className="py-1 pr-3 text-slate-200 break-all">{i.name}{i.orphan ? ' ⚠' : ''}</td>
                    <td className="py-1 pr-3 text-slate-300">{i.status}</td>
                    <td className="py-1 pr-3 text-right tabular-nums text-slate-300">{i.type === 'vm' && i.hourlyCost ? i.hourlyCost.toFixed(2) : '—'}</td>
                    <td className="py-1 text-right tabular-nums text-slate-300">{i.monthlyCost ? i.monthlyCost.toFixed(2) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
