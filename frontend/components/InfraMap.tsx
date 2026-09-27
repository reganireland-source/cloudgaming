'use client';

/**
 * ============================================================================
 * frontend/components/InfraMap.tsx — THE INFRASTRUCTURE WORLD MAP
 * ============================================================================
 *
 * Draws everything you've deployed, where it is, and what state it's in:
 *
 *  • ONE STACKED MARKER per cloud + region. Its colour AND shape AND letter
 *    say which cloud (G circle = Google, A square = AWS, Z triangle = Azure,
 *    O diamond = Oracle), so clouds can be told apart without colour.
 *    A number badge = how many resources are there.
 *  • A STATUS RING around it, from the machines there (worst wins):
 *       green   running        amber  changing (creating/starting/stopping)
 *       grey    stopped        pink   problem (failed / missing)
 *       dashed  resources only (disks, networks… but no machine)
 *    Status is always also written in words (hover, side panel, legend).
 *  • A "!" badge when something there is an ORPHAN (costs money but isn't
 *    attached to anything).
 *  • Faint markers for regions you COULD deploy to (toggle).
 *  • Where our platform runs (Railway backend + Postgres), YOU with estimated
 *    ping rings, and the two paths: control (Railway → deployed regions)
 *    and stream (you ⇄ running machines).
 *  • ZOOM & PAN: scroll / pinch / drag, or the + − ⟲ buttons. Markers stay
 *    the same size on screen while the map zooms.
 *
 * Clicking a marker calls onSelect(groupKey); the page shows the details.
 *
 * DRAWING: d3-geo (Equal Earth projection) + world-atlas land outlines,
 * d3-zoom for zoom/pan. Plain SVG.
 * ============================================================================
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { geoEqualEarth, geoPath, geoCircle, geoDistance, geoInterpolate } from 'd3-geo';
import { feature } from 'topojson-client';
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import { select } from 'd3-selection';
import landTopo from 'world-atlas/land-110m.json';

export interface LatLng { lat: number; lng: number }

// Validated categorical palette + shape + letter (colour never works alone).
export const CLOUD_STYLE: Record<string, { color: string; letter: string; shape: 'circle' | 'square' | 'triangle' | 'diamond'; label: string }> = {
  gcp: { color: '#3987e5', letter: 'G', shape: 'circle', label: 'Google Cloud' },
  aws: { color: '#c98500', letter: 'A', shape: 'square', label: 'AWS' },
  azure: { color: '#199e70', letter: 'Z', shape: 'triangle', label: 'Azure' },
  oracle: { color: '#d55181', letter: 'O', shape: 'diamond', label: 'Oracle' },
};
const PROVIDER_ORDER = ['gcp', 'aws', 'azure', 'oracle'];

export type GroupStatus = 'running' | 'changing' | 'stopped' | 'problem' | 'resources';
export const STATUS_STYLE: Record<GroupStatus, { color: string; label: string; dashed?: boolean }> = {
  running: { color: '#8fd694', label: 'running' },
  changing: { color: '#e8b863', label: 'changing' },
  stopped: { color: '#94a3b8', label: 'stopped' },
  problem: { color: '#ec8aa8', label: 'problem' },
  resources: { color: '#64748b', label: 'resources only', dashed: true },
};

/** One marker: everything one cloud has deployed in one region. */
export interface MarkerGroup {
  key: string;                 // `${provider}:${region}`
  provider: string;
  region: string;
  regionName: string;
  lat: number;
  lng: number;
  count: number;
  status: GroupStatus;
  orphans: number;
  hourly: number;
  monthly: number;
  machines: number;
}

export interface AvailableRegion { provider: string; id: string; name: string; lat: number; lng: number; fromPrice?: number }

/** Estimated round-trip ping: ≈5 ms + distance × 0.015 ms/km (fibre, not straight, both ways). */
export function estimatePingMs(a: LatLng, b: LatLng): number {
  const km = geoDistance([a.lng, a.lat], [b.lng, b.lat]) * 6371;
  return Math.round(5 + km * 0.015);
}

const W = 960;
const H = 480;

function Shape({ shape, size, color, dim }: { shape: string; size: number; color: string; dim?: boolean }) {
  const common = { fill: color, stroke: '#0c1018', strokeWidth: 1.5, opacity: dim ? 0.3 : 1 };
  const s = size;
  switch (shape) {
    case 'square': return <rect x={-s} y={-s} width={s * 2} height={s * 2} rx={1.5} {...common} />;
    case 'triangle': return <polygon points={`0,${-s * 1.25} ${s * 1.15},${s * 0.85} ${-s * 1.15},${s * 0.85}`} {...common} />;
    case 'diamond': return <polygon points={`0,${-s * 1.35} ${s * 1.15},0 0,${s * 1.35} ${-s * 1.15},0`} {...common} />;
    default: return <circle r={s} {...common} />;
  }
}

export default function InfraMap({
  groups, available, user, userLabel = 'You', backend, showAvailable, showRings, showPaths, selectedKey, onSelect, onPickLocation,
}: {
  groups: MarkerGroup[];
  available: AvailableRegion[];
  user: LatLng | null;
  /** Text next to your position, e.g. "You · Singapore". */
  userLabel?: string;
  backend: (LatLng & { label: string }) | null;
  showAvailable: boolean;
  showRings: boolean;
  showPaths: boolean;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onPickLocation: (loc: LatLng) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<{ x: number; y: number; lines: string[] } | null>(null);

  const { projection, path, landPath, spherePath } = useMemo(() => {
    const projection = geoEqualEarth().fitSize([W, H], { type: 'Sphere' } as any);
    const path = geoPath(projection);
    const topo: any = landTopo;
    const land = feature(topo, topo.objects.land) as any;
    return { projection, path, landPath: path(land) || '', spherePath: path({ type: 'Sphere' } as any) || '' };
  }, []);
  const project = (p: LatLng) => projection([p.lng, p.lat]) as [number, number];

  // Zoom & pan (scroll, pinch, drag). Map zooms; markers counter-scale.
  useEffect(() => {
    if (!svgRef.current) return;
    const z = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 12])
      .translateExtent([[0, 0], [W, H]])
      .on('zoom', (e) => setTransform({ x: e.transform.x, y: e.transform.y, k: e.transform.k }));
    zoomRef.current = z;
    select(svgRef.current).call(z);
    return () => { if (svgRef.current) select(svgRef.current).on('.zoom', null); };
  }, []);
  // Zoom around the selected marker if there is one, otherwise the centre.
  const zoomBy = (factor: number) => {
    if (!svgRef.current || !zoomRef.current) return;
    const g = groups.find((x) => x.key === selectedKey);
    const [px, py] = g ? project(g) : [W / 2, H / 2];
    const point: [number, number] = g ? [px * transform.k + transform.x, py * transform.k + transform.y] : [W / 2, H / 2];
    select(svgRef.current).call(zoomRef.current.scaleBy as any, factor, point);
  };
  const resetZoom = () => { if (svgRef.current && zoomRef.current) select(svgRef.current).call(zoomRef.current.transform as any, zoomIdentity); };

  // Clouds sharing a city (e.g. four in Singapore) are fanned out a little.
  const offsetFor = (provider: string, lat: number, lng: number, all: Array<{ provider: string; lat: number; lng: number }>) => {
    const here = all.filter((g) => Math.abs(g.lat - lat) < 1.5 && Math.abs(g.lng - lng) < 1.5).map((g) => g.provider);
    const uniq = PROVIDER_ORDER.filter((p) => here.includes(p));
    if (uniq.length < 2) return [0, 0];
    const i = uniq.indexOf(provider);
    const angle = (i / uniq.length) * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(angle) * 17, Math.sin(angle) * 17];
  };

  const rings = useMemo(() => {
    if (!user) return [];
    return [30, 60, 100].map((ms) => ({ ms, d: path(geoCircle().center([user.lng, user.lat]).radius((ms - 5) / 0.015 / 111.2)() as any) || '' }));
  }, [user, path]);

  const arc = (a: LatLng, b: LatLng) => {
    const interp = geoInterpolate([a.lng, a.lat], [b.lng, b.lat]);
    return path({ type: 'LineString', coordinates: Array.from({ length: 33 }, (_, i) => interp(i / 32)) } as any) || '';
  };

  // Click empty map = set your location (only when not dragging).
  const onBackgroundClick = (e: React.MouseEvent<SVGRectElement | SVGPathElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const { x, y } = pt.matrixTransform(ctm.inverse());
    const lnglat = projection.invert?.([(x - transform.x) / transform.k, (y - transform.y) / transform.k]);
    if (lnglat && Number.isFinite(lnglat[0])) { onPickLocation({ lng: lnglat[0], lat: lnglat[1] }); onSelect(null); }
  };

  const inv = 1 / transform.k; // keep markers/labels constant size on screen
  const deployedKeys = new Set(groups.map((g) => `${g.provider}:${g.region}`));
  const allPoints = [...groups, ...(showAvailable ? available.filter((a) => !deployedKeys.has(`${a.provider}:${a.id}`)) : [])];

  return (
    <div className="relative">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto touch-none select-none bg-[#0a0e15] rounded" role="img"
        aria-label="World map of your deployed infrastructure">
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          <path d={spherePath} fill="#0a0e15" stroke="rgba(255,255,255,0.08)" strokeWidth={inv} onClick={onBackgroundClick} />
          <path d={landPath} fill="#1a2230" stroke="rgba(255,255,255,0.10)" strokeWidth={0.5 * inv} onClick={onBackgroundClick} />

          {showRings && rings.map((r) => (
            <path key={r.ms} d={r.d} fill="none" stroke="rgba(143,214,148,0.35)" strokeDasharray={`${4 * inv} ${4 * inv}`} strokeWidth={inv} pointerEvents="none" />
          ))}

          {showPaths && groups.filter((g) => g.machines > 0).map((g) => (
            <g key={`p-${g.key}`} pointerEvents="none">
              {backend && <path d={arc(backend, g)} fill="none" stroke="#5fd7e0" strokeWidth={inv} opacity={0.45} />}
              {user && g.status === 'running' && <path d={arc(user, g)} fill="none" stroke="#8fd694" strokeWidth={1.5 * inv} strokeDasharray={`${1 * inv} ${3 * inv}`} opacity={0.85} />}
            </g>
          ))}

          {/* Regions you could deploy to (faint) */}
          {showAvailable && available.filter((a) => !deployedKeys.has(`${a.provider}:${a.id}`)).map((a) => {
            const [x, y] = project(a);
            const [dx, dy] = offsetFor(a.provider, a.lat, a.lng, allPoints);
            const st = CLOUD_STYLE[a.provider];
            return (
              <g key={`a-${a.provider}-${a.id}`} transform={`translate(${x},${y}) scale(${inv}) translate(${dx},${dy})`}
                onMouseEnter={() => setHover({ x: transform.x + x * transform.k, y: transform.y + y * transform.k, lines: [`${st.label} · ${a.name}`, 'Nothing deployed here', a.fromPrice ? `From ≈$${a.fromPrice.toFixed(2)}/h` : '', user ? `Est. ping ~${estimatePingMs(user, a)} ms` : ''].filter(Boolean) })}
                onMouseLeave={() => setHover(null)}>
                <Shape shape={st.shape} size={3.5} color={st.color} dim />
              </g>
            );
          })}

          {/* Platform */}
          {backend && (() => {
            const [x, y] = project(backend);
            return (
              <g transform={`translate(${x},${y}) scale(${inv})`}
                onMouseEnter={() => setHover({ x: transform.x + x * transform.k, y: transform.y + y * transform.k, lines: ['Our platform (Railway)', backend.label, 'Backend API + Postgres database', 'Controls machines; not in the game stream'] })}
                onMouseLeave={() => setHover(null)}>
                <rect x={-7} y={-7} width={14} height={14} fill="#0c1018" stroke="#5fd7e0" strokeWidth={2} transform="rotate(45)" />
                <text x={12} y={4} fontSize={10} fill="#cbd5e1">Railway · API + DB</text>
              </g>
            );
          })()}

          {/* Deployed infrastructure */}
          {groups.map((g) => {
            const [x, y] = project(g);
            const [dx, dy] = offsetFor(g.provider, g.lat, g.lng, allPoints);
            const st = CLOUD_STYLE[g.provider];
            const ring = STATUS_STYLE[g.status];
            const size = Math.min(9, 5 + Math.sqrt(g.count));
            const selected = selectedKey === g.key;
            return (
              <g key={g.key} className="cursor-pointer" transform={`translate(${x},${y}) scale(${inv}) translate(${dx},${dy})`}
                onClick={(e) => { e.stopPropagation(); onSelect(selected ? null : g.key); }}
                onMouseEnter={() => setHover({ x: transform.x + x * transform.k, y: transform.y + y * transform.k, lines: [
                  `${st.label} · ${g.regionName}`,
                  `${g.count} resource${g.count === 1 ? '' : 's'} · ${g.machines} machine${g.machines === 1 ? '' : 's'} · ${ring.label}`,
                  g.hourly ? `Running now ≈$${g.hourly.toFixed(2)}/h` : '',
                  g.monthly ? `Standing ≈$${g.monthly.toFixed(2)}/month` : '',
                  g.orphans ? `⚠ ${g.orphans} orphan${g.orphans === 1 ? '' : 's'} still billing` : '',
                  'Click for details',
                ].filter(Boolean) })}
                onMouseLeave={() => setHover(null)}>
                <circle r={size + 8} fill="transparent" />
                {selected && <circle r={size + 9} fill="none" stroke="#f8fafc" strokeWidth={1.5} />}
                <circle r={size + 4.5} fill="none" stroke={ring.color} strokeWidth={2.5} strokeDasharray={ring.dashed ? '3 3' : undefined} />
                {g.status === 'running' && <circle r={size + 4.5} fill="none" stroke={ring.color} strokeWidth={1.5} opacity={0.6}>
                  <animate attributeName="r" from={size + 4.5} to={size + 11} dur="2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.6" to="0" dur="2s" repeatCount="indefinite" />
                </circle>}
                <Shape shape={st.shape} size={size} color={st.color} />
                <text y={3.5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0c1018" pointerEvents="none">{st.letter}</text>
                {g.count > 1 && (
                  <g transform={`translate(${size + 3},${-size - 3})`}>
                    <circle r={6.5} fill="#f8fafc" stroke="#0c1018" strokeWidth={1} />
                    <text y={3} textAnchor="middle" fontSize={8} fontWeight={700} fill="#0c1018">{g.count}</text>
                  </g>
                )}
                {g.orphans > 0 && (
                  <g transform={`translate(${-size - 4},${-size - 3})`}>
                    <polygon points="0,-6.5 6,4.5 -6,4.5" fill="#ec8aa8" stroke="#0c1018" strokeWidth={1} />
                    <text y={3.3} textAnchor="middle" fontSize={7.5} fontWeight={800} fill="#0c1018">!</text>
                  </g>
                )}
              </g>
            );
          })}

          {user && (() => {
            const [x, y] = project(user);
            return (
              <g transform={`translate(${x},${y}) scale(${inv})`} pointerEvents="none">
                <circle r={5} fill="#f8fafc" stroke="#0c1018" strokeWidth={2} />
                <text x={9} y={4} fontSize={11} fill="#f8fafc" fontWeight={600}>{userLabel}</text>
              </g>
            );
          })()}
        </g>
      </svg>

      {/* Zoom controls */}
      <div className="absolute top-2 right-2 flex flex-col gap-1">
        {[['+', () => zoomBy(1.6), 'Zoom in'], ['−', () => zoomBy(1 / 1.6), 'Zoom out'], ['⟲', resetZoom, 'Reset view']].map(([label, fn, title]) => (
          <button key={title as string} type="button" onClick={fn as () => void} title={title as string} aria-label={title as string}
            className="w-7 h-7 rounded border border-white/15 bg-cyber-darker/90 text-slate-200 hover:border-neon-cyan text-sm leading-none">
            {label as string}
          </button>
        ))}
      </div>

      {hover && (
        <div className="pointer-events-none absolute z-10 rounded border border-white/15 bg-cyber-darker/95 px-2.5 py-1.5 text-[0.7rem] text-slate-200 shadow-lg max-w-[270px]"
          style={{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%`, transform: 'translate(14px, -50%)' }}>
          {hover.lines.map((l, i) => <p key={i} className={i === 0 ? 'font-semibold text-slate-100' : 'text-slate-300'}>{l}</p>)}
        </div>
      )}
    </div>
  );
}
