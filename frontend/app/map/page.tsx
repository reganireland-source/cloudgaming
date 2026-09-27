'use client';

/**
 * ============================================================================
 * frontend/app/map/page.tsx — THE WORLD MAP (/map)
 * ============================================================================
 *
 * Where every cloud region is, how far each is from you (estimated ping),
 * what it costs, where your machines are running, and where the backend
 * lives. The map itself is components/WorldMap.tsx; this page loads the data
 * and adds the controls, legend and a "nearest regions" table (the same
 * information as the map, in text form).
 *
 * DATA
 *   GET /api/status/catalog  (public)  regions, GPUs, prices, backend region
 *   GET /api/machines        (signed in only)  your machines
 *
 * YOUR LOCATION is only ever used in your browser (never sent anywhere) and
 * remembered in this browser's storage. Choose "Use my location" (the
 * browser asks permission) or click anywhere on the map. Until then, a rough
 * guess from your time zone is used.
 * ============================================================================
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { apiUrl } from '@/lib/api';
import { apiFetch } from '@/lib/auth';
import { useAuth } from '@/components/AuthProvider';
import WorldMap, { CLOUD_STYLE, estimatePingMs, type LatLng, type MapMachine, type MapRegion } from '@/components/WorldMap';

interface Catalog {
  providers: Array<{
    provider: string;
    label: string;
    priceNote: string;
    regions: Array<{ id: string; name: string; lat: number; lng: number; gpus: string[]; cheapest: MapRegion['cheapest'] }>;
  }>;
  backendRegion: string | null;
}

/** Railway region codes (prefix) → approximate location. */
const RAILWAY_REGIONS: Array<{ prefix: string; label: string; lat: number; lng: number }> = [
  { prefix: 'us-west', label: 'US West (California)', lat: 37.4, lng: -122.0 },
  { prefix: 'us-east', label: 'US East (Virginia)', lat: 39.0, lng: -77.5 },
  { prefix: 'europe-west', label: 'EU West (Amsterdam)', lat: 52.4, lng: 4.9 },
  { prefix: 'asia-southeast', label: 'Southeast Asia (Singapore)', lat: 1.35, lng: 103.8 },
];

const LOCATION_KEY = 'cg_location';

function guessFromTimezone(): LatLng & { approximate: true } {
  // Very rough: longitude from the UTC offset (15° per hour), a mid latitude.
  const lng = Math.max(-179, Math.min(179, (-new Date().getTimezoneOffset() / 60) * 15));
  return { lat: 20, lng, approximate: true };
}

function pingLabel(ms: number): { text: string; cls: string } {
  if (ms <= 30) return { text: 'great', cls: 'text-neon-lime' };
  if (ms <= 60) return { text: 'ok', cls: 'text-neon-amber' };
  return { text: 'laggy', cls: 'text-neon-pink' };
}

function ShapeIcon({ provider }: { provider: string }) {
  const s = CLOUD_STYLE[provider];
  if (!s) return null;
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="inline-block align-[-1px]">
      {s.shape === 'circle' && <circle cx="6" cy="6" r="5" fill={s.color} />}
      {s.shape === 'square' && <rect x="1" y="1" width="10" height="10" rx="1.5" fill={s.color} />}
      {s.shape === 'triangle' && <polygon points="6,0.5 11.5,11 0.5,11" fill={s.color} />}
      {s.shape === 'diamond' && <polygon points="6,0 12,6 6,12 0,6" fill={s.color} />}
    </svg>
  );
}

export default function MapPage() {
  const { user } = useAuth();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [machines, setMachines] = useState<MapMachine[]>([]);
  const [location, setLocation] = useState<(LatLng & { approximate?: boolean }) | null>(null);
  const [locating, setLocating] = useState(false);
  const [visible, setVisible] = useState<Set<string>>(new Set(['gcp', 'aws', 'azure', 'oracle']));

  // Remembered location, or a time-zone guess.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LOCATION_KEY);
      if (saved) { setLocation(JSON.parse(saved)); return; }
    } catch { /* storage blocked */ }
    setLocation(guessFromTimezone());
  }, []);

  const saveLocation = (loc: LatLng) => {
    setLocation(loc);
    try { localStorage.setItem(LOCATION_KEY, JSON.stringify(loc)); } catch { /* ignore */ }
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) { setError('This browser can\'t share its location — click on the map instead.'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { saveLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setLocating(false); },
      () => { setError('Location permission was denied — click on the map to set where you are instead.'); setLocating(false); },
      { enableHighAccuracy: false, timeout: 10000 }
    );
  };

  // Public catalog.
  useEffect(() => {
    fetch(apiUrl('/status/catalog'), { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setCatalog)
      .catch((e) => setError(e.message === 'HTTP 404'
        ? 'The backend is an older version without the map data — redeploy it on Railway.'
        : `Couldn't load regions (${e.message}). Check the BACKEND light.`));
  }, []);

  const regions: MapRegion[] = useMemo(() => (catalog?.providers || []).flatMap((p) =>
    p.regions.map((r) => ({ ...r, provider: p.provider, providerLabel: p.label }))), [catalog]);

  // Your machines (signed in), placed at their region's coordinates.
  useEffect(() => {
    if (!user || regions.length === 0) { setMachines([]); return; }
    apiFetch<any[]>('/machines')
      .then((list) => setMachines(list
        .filter((m) => !['deleting'].includes(m.status))
        .map((m) => {
          const r = regions.find((x) => x.provider === m.provider && x.id === m.region);
          return r ? { ...m, cost_per_hour: Number(m.cost_per_hour) || 0, lat: r.lat, lng: r.lng } : null;
        })
        .filter(Boolean) as MapMachine[]))
      .catch(() => setMachines([]));
  }, [user, regions]);

  const backend = useMemo(() => {
    const code = catalog?.backendRegion || '';
    const match = RAILWAY_REGIONS.find((r) => code.startsWith(r.prefix));
    return match ? { lat: match.lat, lng: match.lng, label: `${match.label} · ${code}` } : null;
  }, [catalog]);

  const nearest = useMemo(() => {
    if (!location) return [];
    return regions
      .filter((r) => visible.has(r.provider))
      .map((r) => ({ ...r, ping: estimatePingMs(location, r) }))
      .sort((a, b) => a.ping - b.ping)
      .slice(0, 12);
  }, [regions, location, visible]);

  const running = machines.filter((m) => m.status === 'running');

  const toggle = (p: string) => setVisible((v) => {
    const next = new Set(v);
    if (next.has(p)) next.delete(p); else next.add(p);
    return next;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold neon-text mb-1 font-mono">[ WORLD_MAP ]</h1>
          <p className="text-sm text-slate-400 max-w-2xl">
            Every region you can launch in, how far it is from you, what it costs, and where your machines and the backend are running.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={useMyLocation} disabled={locating} className="btn-neon text-xs disabled:opacity-50">
            {locating ? 'Locating…' : '◎ Use my location'}
          </button>
          <span className="text-xs text-slate-500">or click the map</span>
        </div>
      </div>

      {error && <p className="text-sm text-neon-amber">⚠ {error}</p>}
      {location?.approximate && (
        <p className="text-xs text-slate-500">Your position is a rough guess from your time zone — use your location or click the map for accurate ping estimates.</p>
      )}

      {/* Filters + legend, one row above the map */}
      <div className="flex flex-wrap items-center gap-2">
        {Object.entries(CLOUD_STYLE).map(([key, s]) => (
          <button key={key} type="button" onClick={() => toggle(key)} aria-pressed={visible.has(key)}
            className={`inline-flex items-center gap-1.5 text-xs rounded border px-2.5 py-1 ${visible.has(key) ? 'border-white/25 text-slate-200' : 'border-white/10 text-slate-500 line-through'}`}>
            <ShapeIcon provider={key} /> {s.label}
          </button>
        ))}
        <span className="text-[0.7rem] text-slate-500 ml-2 flex flex-wrap gap-3">
          <span>◯ ring = your machine (green running · grey stopped)</span>
          <span className="text-neon-lime">┈ stream path</span>
          <span className="text-neon-cyan">— control path</span>
          <span>╌ ping rings 30 / 60 / 100 ms</span>
        </span>
      </div>

      <div className="grid lg:grid-cols-[1fr,300px] gap-4">
        <div className="neon-card rounded-lg border border-white/10 p-2 self-start">
          {catalog ? (
            <WorldMap regions={regions} machines={machines} user={location} backend={backend} visibleClouds={visible} onPickLocation={saveLocation} />
          ) : (
            <p className="font-mono text-sm text-neon-cyan animate-pulse p-6">&gt; LOADING_MAP…</p>
          )}
        </div>

        <aside className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded border border-white/10 bg-white/[0.02] px-3 py-2">
              <p className="label">Closest</p>
              <p className="text-sm text-slate-100 mt-0.5">{nearest[0] ? `${nearest[0].name}` : '—'}</p>
              <p className="text-[0.68rem] text-slate-500">{nearest[0] ? `~${nearest[0].ping} ms · ${CLOUD_STYLE[nearest[0].provider].label}` : ''}</p>
            </div>
            <div className="rounded border border-white/10 bg-white/[0.02] px-3 py-2">
              <p className="label">Running</p>
              <p className="text-sm text-slate-100 mt-0.5 tabular-nums">{user ? `${running.length} machine${running.length === 1 ? '' : 's'}` : '—'}</p>
              <p className="text-[0.68rem] text-slate-500">{user ? `≈$${running.reduce((s, m) => s + m.cost_per_hour, 0).toFixed(2)}/h` : <Link href="/login?next=/map" className="text-neon-cyan">sign in</Link>}</p>
            </div>
          </div>

          <div className="rounded border border-white/10">
            <p className="label px-3 pt-3 pb-2">Nearest regions (estimated ping)</p>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 text-left">
                  <th className="px-3 py-1 font-normal">Region</th>
                  <th className="px-2 py-1 font-normal text-right">Ping</th>
                  <th className="px-3 py-1 font-normal text-right">From</th>
                </tr>
              </thead>
              <tbody>
                {nearest.map((r) => {
                  const q = pingLabel(r.ping);
                  return (
                    <tr key={`${r.provider}-${r.id}`} className="border-t border-white/5">
                      <td className="px-3 py-1.5 text-slate-200">
                        <ShapeIcon provider={r.provider} /> {r.name}
                        <span className="block text-[0.65rem] text-slate-500 pl-4">{CLOUD_STYLE[r.provider].label} · {r.gpus.join('/')}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-200">
                        {r.ping} ms <span className={`block text-[0.62rem] ${q.cls}`}>{q.text}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-300">{r.cheapest ? `$${r.cheapest.onDemand.toFixed(2)}/h` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-[0.65rem] text-slate-500 px-3 py-2 leading-relaxed">
              Ping is estimated from distance (≈5 ms + 1.5 ms per 100 km); your real ping depends on your internet provider. Under ~30 ms feels local;
              over ~60 ms is noticeable in fast games. Prices are on-demand estimates.
            </p>
          </div>
          <p className="text-[0.68rem] text-slate-500 leading-relaxed">
            The website itself is served by Vercel from the edge location nearest you, so it isn&apos;t drawn. The game stream goes straight between you and the machine.
          </p>
        </aside>
      </div>
    </div>
  );
}
