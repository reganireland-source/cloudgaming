'use client';

/**
 * ============================================================================
 * frontend/components/WorldMap.tsx — WHERE EVERYTHING IS, AND HOW FAR FROM YOU
 * ============================================================================
 *
 * One map, four layers:
 *   1. CLOUD REGIONS — every region the app can launch in, on all four
 *      clouds. Each cloud has its own colour AND marker shape AND letter
 *      (G/A/Z/O), so they can be told apart without relying on colour.
 *      Hover (or tap) a marker for GPUs, the cheapest price and estimated ping.
 *   2. YOU — your location (from the browser if you allow it, or wherever you
 *      click on the map), with dashed rings at ~30, ~60 and ~100 ms
 *      estimated ping. Regions inside the inner ring feel "local".
 *   3. YOUR MACHINES — bigger markers with a status ring, and lines showing
 *      the two paths: the game STREAM (you ⇄ machine, direct) and the
 *      CONTROL path (backend on Railway → machine's cloud).
 *   4. THE BACKEND — where the Railway API server runs (Vercel serves the
 *      website from a global CDN, so it's everywhere and isn't drawn).
 *
 * ESTIMATED PING: straight-line distance, assuming light in fibre covers
 * ~200 km per millisecond, doubled for the round trip, ×1.5 because real
 * cables don't run straight, plus ~5 ms for the last mile:
 *     ping ≈ 5 + distance_km × 0.015 ms
 * Real ping depends on your ISP and routing; treat it as a guide.
 *
 * DRAWING: d3-geo projects latitude/longitude to x/y (Equal Earth
 * projection, which keeps areas honest), topojson-client unpacks the
 * world-atlas land outlines. Everything is plain SVG.
 * ============================================================================
 */

import { useMemo, useState } from 'react';
import { geoEqualEarth, geoPath, geoCircle, geoDistance, geoInterpolate } from 'd3-geo';
import { feature } from 'topojson-client';
import landTopo from 'world-atlas/land-110m.json';

export interface MapRegion {
  provider: string;
  providerLabel: string;
  id: string;
  name: string;
  lat: number;
  lng: number;
  gpus: string[];
  cheapest: { shape: string; gpu: string; onDemand: number } | null;
}

export interface MapMachine {
  id: string;
  provider: string;
  region: string;
  instance_type: string;
  status: string;
  cost_per_hour: number;
  lat: number;
  lng: number;
}

export interface LatLng { lat: number; lng: number }

// Validated categorical palette (dataviz reference palette, dark steps) —
// with shape + letter as a second encoding, since four hues can't all be
// told apart by every colour-vision type.
export const CLOUD_STYLE: Record<string, { color: string; letter: string; shape: 'circle' | 'square' | 'triangle' | 'diamond'; label: string }> = {
  gcp: { color: '#3987e5', letter: 'G', shape: 'circle', label: 'Google Cloud' },
  aws: { color: '#c98500', letter: 'A', shape: 'square', label: 'AWS' },
  azure: { color: '#199e70', letter: 'Z', shape: 'triangle', label: 'Azure' },
  oracle: { color: '#d55181', letter: 'O', shape: 'diamond', label: 'Oracle' },
};

const W = 960;
const H = 480;

/** Estimated round-trip ping between two points (see header). */
export function estimatePingMs(a: LatLng, b: LatLng): number {
  const km = geoDistance([a.lng, a.lat], [b.lng, b.lat]) * 6371;
  return Math.round(5 + km * 0.015);
}

function pingToKm(ms: number): number {
  return (ms - 5) / 0.015;
}

function Marker({ x, y, style, size, dim }: { x: number; y: number; style: (typeof CLOUD_STYLE)[string]; size: number; dim?: boolean }) {
  const common = { fill: style.color, stroke: '#0c1018', strokeWidth: 1.5, opacity: dim ? 0.35 : 0.95 };
  const s = size;
  switch (style.shape) {
    case 'square': return <rect x={x - s} y={y - s} width={s * 2} height={s * 2} rx={1.5} {...common} />;
    case 'triangle': return <polygon points={`${x},${y - s * 1.2} ${x + s * 1.1},${y + s * 0.8} ${x - s * 1.1},${y + s * 0.8}`} {...common} />;
    case 'diamond': return <polygon points={`${x},${y - s * 1.3} ${x + s * 1.1},${y} ${x},${y + s * 1.3} ${x - s * 1.1},${y}`} {...common} />;
    default: return <circle cx={x} cy={y} r={s} {...common} />;
  }
}

export default function WorldMap({
  regions, machines, user, backend, visibleClouds, onPickLocation,
}: {
  regions: MapRegion[];
  machines: MapMachine[];
  user: LatLng | null;
  backend: (LatLng & { label: string }) | null;
  visibleClouds: Set<string>;
  onPickLocation: (loc: LatLng) => void;
}) {
  const [hover, setHover] = useState<{ x: number; y: number; lines: string[] } | null>(null);

  // Projection + land outlines are computed once.
  const { projection, path, landPath, spherePath } = useMemo(() => {
    const projection = geoEqualEarth().fitSize([W, H], { type: 'Sphere' } as any);
    const path = geoPath(projection);
    const topo: any = landTopo;
    const land = feature(topo, topo.objects.land) as any;
    return { projection, path, landPath: path(land) || '', spherePath: path({ type: 'Sphere' } as any) || '' };
  }, []);

  const project = (p: LatLng) => projection([p.lng, p.lat]) as [number, number];

  // Dashed "ping rings" around the user: geo circles, so they curve correctly.
  const rings = useMemo(() => {
    if (!user) return [];
    return [30, 60, 100].map((ms) => ({
      ms,
      d: path(geoCircle().center([user.lng, user.lat]).radius(pingToKm(ms) / 111.2)() as any) || '',
    }));
  }, [user, path]);

  // Great-circle arc between two points, as an SVG path.
  const arc = (a: LatLng, b: LatLng) => {
    const interp = geoInterpolate([a.lng, a.lat], [b.lng, b.lat]);
    const line = { type: 'LineString', coordinates: Array.from({ length: 33 }, (_, i) => interp(i / 32)) };
    return path(line as any) || '';
  };

  // Click anywhere on the map to set your location.
  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const { x, y } = pt.matrixTransform(ctm.inverse());
    const lnglat = projection.invert?.([x, y]);
    if (lnglat && Number.isFinite(lnglat[0]) && Number.isFinite(lnglat[1])) onPickLocation({ lng: lnglat[0], lat: lnglat[1] });
  };

  const statusRing: Record<string, string> = { running: '#8fd694', stopped: '#94a3b8', failed: '#ec8aa8', missing: '#ec8aa8' };

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto cursor-crosshair select-none" role="img"
        aria-label="World map of cloud regions, your location and your machines" onClick={onClick}>
        {/* Ocean + land: recessive, so the markers carry the information */}
        <path d={spherePath} fill="#0a0e15" stroke="rgba(255,255,255,0.08)" />
        <path d={landPath} fill="#1a2230" stroke="rgba(255,255,255,0.10)" strokeWidth={0.5} />

        {/* Ping rings around you */}
        {rings.map((r) => (
          <g key={r.ms}>
            <path d={r.d} fill="none" stroke="rgba(143,214,148,0.35)" strokeDasharray="4 4" strokeWidth={1} />
          </g>
        ))}

        {/* Paths to your machines: stream (you ⇄ machine) and control (backend → machine) */}
        {machines.map((m) => (
          <g key={`paths-${m.id}`}>
            {user && <path d={arc(user, m)} fill="none" stroke="#8fd694" strokeWidth={1.5} strokeDasharray="1 3" opacity={0.8} />}
            {backend && <path d={arc(backend, m)} fill="none" stroke="#5fd7e0" strokeWidth={1} opacity={0.5} />}
          </g>
        ))}

        {/* Cloud regions */}
        {regions.filter((r) => visibleClouds.has(r.provider)).map((r) => {
          const [x, y] = project(r);
          const style = CLOUD_STYLE[r.provider];
          const ping = user ? estimatePingMs(user, r) : null;
          return (
            <g key={`${r.provider}-${r.id}`}
              onMouseEnter={() => setHover({ x, y, lines: [
                `${style.label} · ${r.name} (${r.id})`,
                `GPUs: ${r.gpus.join(', ')}`,
                r.cheapest ? `From ≈$${r.cheapest.onDemand.toFixed(2)}/h (${r.cheapest.gpu})` : 'No priced sizes',
                ping !== null ? `Estimated ping from you: ~${ping} ms` : 'Set your location to see ping',
              ] })}
              onMouseLeave={() => setHover(null)}>
              {/* larger invisible hit area */}
              <circle cx={x} cy={y} r={10} fill="transparent" />
              <Marker x={x} y={y} style={style} size={4.5} />
            </g>
          );
        })}

        {/* Backend (Railway) */}
        {backend && (() => {
          const [x, y] = project(backend);
          return (
            <g onMouseEnter={() => setHover({ x, y, lines: ['Backend API (Railway)', backend.label, 'Controls machines; not in the game stream'] })} onMouseLeave={() => setHover(null)}>
              <rect x={x - 6} y={y - 6} width={12} height={12} fill="none" stroke="#5fd7e0" strokeWidth={2} transform={`rotate(45 ${x} ${y})`} />
              <text x={x + 10} y={y + 4} fontSize={10} fill="#cbd5e1">Railway</text>
            </g>
          );
        })()}

        {/* Your machines */}
        {machines.map((m) => {
          const [x, y] = project(m);
          const style = CLOUD_STYLE[m.provider];
          const ping = user ? estimatePingMs(user, m) : null;
          return (
            <g key={m.id}
              onMouseEnter={() => setHover({ x, y, lines: [
                `Your machine · ${m.instance_type}`,
                `${style?.label} · ${m.region} · ${m.status}`,
                m.status === 'running' ? `Costing ≈$${m.cost_per_hour.toFixed(2)}/h now` : 'Not running — no compute charge',
                ping !== null ? `Estimated ping: ~${ping} ms` : '',
              ].filter(Boolean) })}
              onMouseLeave={() => setHover(null)}>
              <circle cx={x} cy={y} r={11} fill="none" stroke={statusRing[m.status] || '#e8b863'} strokeWidth={2.5} />
              {style && <Marker x={x} y={y} style={style} size={6} />}
            </g>
          );
        })}

        {/* You */}
        {user && (() => {
          const [x, y] = project(user);
          return (
            <g pointerEvents="none">
              <circle cx={x} cy={y} r={5} fill="#f8fafc" stroke="#0c1018" strokeWidth={2} />
              <text x={x + 9} y={y + 4} fontSize={11} fill="#f8fafc" fontWeight={600}>You</text>
            </g>
          );
        })()}
      </svg>

      {/* Tooltip — text colours, never the series colour */}
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded border border-white/15 bg-cyber-darker/95 px-2.5 py-1.5 text-[0.7rem] text-slate-200 shadow-lg max-w-[260px]"
          style={{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%`, transform: 'translate(12px, -50%)' }}
        >
          {hover.lines.map((l, i) => <p key={i} className={i === 0 ? 'font-semibold text-slate-100' : 'text-slate-300'}>{l}</p>)}
        </div>
      )}
    </div>
  );
}
