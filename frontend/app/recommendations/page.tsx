'use client';

/**
 * ============================================================================
 * app/recommendations/page.tsx — GAME RECON: WHERE TO PLAY, AND ON WHAT
 * ============================================================================
 *
 * 1. Where are you? Type a city or country ("Melbourne", "Japan",
 *    "Portland, Oregon"), use your internet connection's location, or enter
 *    coordinates. Names become lat/lng via app/api/geocode.
 * 2. Pick a hardware tier — GOOD (T4, 1080p60), BETTER (L4/A10G, 1440p60),
 *    BEST (L4/A10G/A10 with more CPU, up to 4K60). Each tier card shows its
 *    best nearby price; a game title highlights the tier it needs.
 * 3. The list ranks every cloud region for that tier by estimated ping, then
 *    price (machine + data sent to you). [ LAUNCH ] opens the launch form
 *    pre-filled with that exact cloud, region and machine.
 *
 * Numbers come from GET /api/recon (src/services/ReconService.ts), which
 * reads the same price catalogs as the launch form. Results refresh by
 * themselves whenever an input changes.
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/auth';
import { useAuth } from '@/components/AuthProvider';
import LaunchMachineModal, { type LaunchPreset } from '@/components/LaunchMachineModal';
import { placeLabel, type Place } from '@/lib/places';

type TierId = 'good' | 'better' | 'best';
type Rating = 'excellent' | 'good' | 'fair' | 'poor';

interface Option {
  provider: string; providerLabel: string; region: string; regionName: string;
  shapeId: string; shapeLabel: string; gpuModel: string; vcpus: number; memoryGb: number;
  latencyMs: number; latencyRating: Rating;
  computePerHour: number; spot: boolean; spotLabel: string; egressPerHour: number; totalPerHour: number;
}
interface Tier {
  id: TierId; label: string; gpuClass: string; gpuShort: string; resolution: string; fps: number; gbPerHour: number; bestFor: string;
  options: Option[]; totalOptions: number; overBudget: number; tooFar: number; closest: Option | null; cheapest: Option | null;
  offeredBy: string[]; notOfferedBy: string[];
}
interface ReconResult {
  game: { title: string; gpuClass: string; suggestedTier: TierId } | null;
  gameNotFound: boolean; games: string[]; tiers: Tier[];
}
interface ChosenPlace { label: string; lat: number; lng: number; source: 'search' | 'ip' | 'gps' | 'manual' }

// Same colours / letters as the infrastructure map, so a cloud looks the same everywhere.
const CLOUD: Record<string, { color: string; letter: string }> = {
  gcp: { color: '#3987e5', letter: 'G' }, aws: { color: '#c98500', letter: 'A' },
  azure: { color: '#199e70', letter: 'Z' }, oracle: { color: '#d55181', letter: 'O' },
};
const RATING: Record<Rating, { label: string; className: string }> = {
  excellent: { label: 'Excellent', className: 'text-neon-lime' },
  good: { label: 'Good', className: 'text-neon-cyan' },
  fair: { label: 'Fair', className: 'text-neon-amber' },
  poor: { label: 'Laggy', className: 'text-neon-pink' },
};
// Tier → the launch form's streaming quality.
const TIER_QUALITY: Record<TierId, string> = { good: 'good', better: 'high', best: 'ultra' };
const QUICK_PICKS = ['Sydney', 'Singapore', 'Tokyo', 'London', 'New York', 'Los Angeles'];
const STORE_KEY = 'recon.place';

const money = (n: number) => `$${n.toFixed(2)}`;

export default function RecommendationsPage() {
  const { user } = useAuth();
  const [place, setPlace] = useState<ChosenPlace | null>(null);
  const [game, setGame] = useState('');
  const [budget, setBudget] = useState('');
  const [spot, setSpot] = useState(false);
  const [tierId, setTierId] = useState<TierId>('better');
  const [result, setResult] = useState<ReconResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launch, setLaunch] = useState<LaunchPreset | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateNote, setLocateNote] = useState<string | null>(null);

  // ---- Location: remembered place, else the connection's rough location ----
  const choose = useCallback((p: ChosenPlace) => {
    setPlace(p);
    setLocateNote(null);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* storage blocked: fine */ }
  }, []);

  const useMyLocation = useCallback(async (quiet = false) => {
    setLocating(true);
    setLocateNote(null);
    try {
      // 1. Rough location from the internet connection (no prompt; Vercel headers).
      const geo = await fetch('/api/geo').then((r) => r.json()).catch(() => ({ available: false }));
      if (geo.available) {
        choose({ label: [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || 'Your connection', lat: geo.lat, lng: geo.lng, source: 'ip' });
        return;
      }
      if (quiet) return;
      // 2. Otherwise ask the device (the browser shows a permission prompt).
      if (!navigator.geolocation) throw new Error('This browser can’t share its location. Type your city instead.');
      const pos = await new Promise<GeolocationPosition>((ok, fail) =>
        navigator.geolocation.getCurrentPosition(ok, fail, { timeout: 10000, maximumAge: 600000 }));
      choose({ label: 'Your device’s location', lat: pos.coords.latitude, lng: pos.coords.longitude, source: 'gps' });
    } catch (e: any) {
      if (!quiet) setLocateNote(e?.code === 1 ? 'Location permission was declined — type your city or country instead.' : e?.message || 'Couldn’t find your location — type your city instead.');
    } finally {
      setLocating(false);
    }
  }, [choose]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved) { setPlace(JSON.parse(saved)); return; }
    } catch { /* ignore */ }
    useMyLocation(true);
  }, [useMyLocation]);

  // ---- Recommendations: refetch when any input changes (debounced) ----
  const suggestedFor = useRef<string | null>(null); // game whose tier we already auto-selected
  useEffect(() => {
    if (!place) return;
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({ lat: String(place.lat), lng: String(place.lng) });
      if (budget && parseFloat(budget) > 0) qs.set('budget', budget);
      if (spot) qs.set('spot', 'true');
      if (game.trim()) qs.set('game', game.trim());
      try {
        const r = await apiFetch<ReconResult>(`/recon?${qs}`);
        setResult(r);
        // A newly recognised game selects the tier it needs, once — after
        // that the player's own tier choice sticks.
        if (r.game && suggestedFor.current !== r.game.title) {
          suggestedFor.current = r.game.title;
          setTierId(r.game.suggestedTier);
        }
      } catch (e) {
        setError((e as ApiError).message || 'Couldn’t load recommendations.');
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [place, budget, spot, game]);

  const tier = result?.tiers.find((t) => t.id === tierId);

  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl font-bold neon-text mb-1 font-mono">[ GAME_RECON ]</h1>
        <p className="text-sm text-slate-400 max-w-2xl short:hidden">Find the closest, cheapest cloud machine for where you play — pick a hardware tier and launch it in one tap.</p>
      </div>

      {/* ---- Inputs ---- */}
      <section className="neon-card rounded-lg p-3 sm:p-5 border border-neon-cyan/30 space-y-3 sm:space-y-4">
        <div>
          <label htmlFor="recon-place" className="block text-xs font-bold text-neon-cyan mb-1.5 font-mono">WHERE_ARE_YOU_PLAYING_FROM</label>
          <PlaceSearch onPick={choose} />
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            {place ? (
              <span className="text-slate-300 min-w-0">
                📍 <span className="text-slate-100">{place.label}</span>{' '}
                <span className="text-slate-500 tabular-nums">({place.lat.toFixed(2)}, {place.lng.toFixed(2)}{place.source === 'ip' ? ' · from your connection' : ''})</span>
              </span>
            ) : (
              <span className="text-slate-400">No location yet — search above, or:</span>
            )}
            <button type="button" onClick={() => useMyLocation(false)} disabled={locating} className="text-neon-cyan hover:underline disabled:opacity-50">
              {locating ? 'Locating…' : '◎ Use my location'}
            </button>
            <CoordinatesEditor place={place} onSet={choose} />
          </div>
          {locateNote && <p className="mt-1.5 text-xs text-neon-amber">⚠ {locateNote}</p>}
          {!place && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {QUICK_PICKS.map((city) => <QuickPick key={city} city={city} onPick={choose} />)}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-[2fr,1fr,auto] gap-3 items-end">
          <div className="col-span-2 sm:col-span-1">
            <label htmlFor="recon-game" className="block text-xs font-bold text-neon-cyan mb-1.5 font-mono">GAME <span className="text-slate-500 font-normal">(optional)</span></label>
            <input id="recon-game" list="recon-games" value={game} onChange={(e) => setGame(e.target.value)} placeholder="e.g. Elden Ring"
              className="input-neon w-full px-3 py-2 rounded font-mono text-sm" autoComplete="off" />
            <datalist id="recon-games">{result?.games.map((g) => <option key={g} value={g} />)}</datalist>
          </div>
          <div>
            <label htmlFor="recon-budget" className="block text-xs font-bold text-neon-cyan mb-1.5 font-mono">MAX_$/HOUR</label>
            <input id="recon-budget" type="number" inputMode="decimal" min="0" step="0.05" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="any"
              className="input-neon w-full px-3 py-2 rounded font-mono text-sm" />
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-300 pb-2.5 cursor-pointer" title="Spare capacity sold cheaply; the cloud can stop it at short notice.">
            <input type="checkbox" checked={spot} onChange={(e) => setSpot(e.target.checked)} className="accent-cyan-400 h-4 w-4" />
            Spot pricing
          </label>
        </div>
        {result?.gameNotFound && game.trim() && (
          <p className="text-xs text-slate-400">“{game.trim()}” isn’t in the game library yet — pick a tier yourself{result.games.length ? ` (known: ${result.games.join(', ')})` : ''}.</p>
        )}
      </section>

      {error && <p className="text-sm text-neon-amber">⚠ {error}</p>}

      {!place ? null : !result ? (
        <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; SCANNING_REGIONS…</p>
      ) : (
        <>
          {/* ---- Tier picker: GOOD / BETTER / BEST ---- */}
          <div role="radiogroup" aria-label="Hardware tier" className="grid grid-cols-3 gap-2 sm:gap-3">
            {result.tiers.map((t) => {
              const pick = t.options[0];
              const selected = t.id === tierId;
              const suggested = result.game?.suggestedTier === t.id;
              return (
                <button key={t.id} type="button" role="radio" aria-checked={selected} onClick={() => setTierId(t.id)}
                  className={`relative text-left rounded-lg border p-2 sm:p-3 transition ${selected ? 'border-neon-cyan bg-neon-cyan/[0.07]' : 'border-white/10 hover:border-white/25'}`}>
                  {suggested && <span className="absolute -top-2 right-1.5 text-[0.6rem] rounded bg-cyber-dark border border-neon-magenta/60 text-neon-magenta px-1 leading-4">★ PICK</span>}
                  <span className={`block font-mono font-bold text-sm tracking-label ${selected ? 'text-neon-cyan' : 'text-slate-200'}`}>{t.label.toUpperCase()}</span>
                  <span className="block text-[0.7rem] text-slate-400">{t.resolution}{t.fps}</span>
                  <span className="block text-[0.7rem] text-slate-500 truncate" title={t.gpuClass}>{t.gpuShort}</span>
                  <span className="block mt-1 text-sm text-slate-100 tabular-nums">{pick ? <>{money(pick.totalPerHour)}<span className="text-slate-500 text-[0.7rem]">/h</span></> : <span className="text-slate-500 text-xs">over budget</span>}</span>
                  {pick && <span className={`block text-[0.7rem] tabular-nums ${RATING[pick.latencyRating].className}`}>~{pick.latencyMs} ms</span>}
                </button>
              );
            })}
          </div>

          {tier && (
            <section aria-live="polite" className="space-y-2 sm:space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-xs text-slate-400">
                  <span className="text-slate-200 font-semibold">{tier.label}:</span> {tier.gpuClass} · {tier.resolution}{tier.fps} · {tier.bestFor}.
                  {result.game?.suggestedTier === tier.id && <> Suggested for {result.game.title}.</>}
                  {tier.notOfferedBy.length > 0 && <> Not offered on {tier.notOfferedBy.join(' or ')}.</>}
                </p>
                {loading && <span className="text-[0.7rem] text-neon-cyan animate-pulse">updating…</span>}
              </div>

              {tier.options.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/15 p-4 text-sm text-slate-400">
                  Nothing in this tier fits {money(parseFloat(budget) || 0)}/hour.{tier.cheapest && <> Cheapest is {money(tier.cheapest.totalPerHour)}/h in {tier.cheapest.regionName} ({tier.cheapest.providerLabel}).</>}
                </div>
              ) : (
                <ol className="space-y-2">
                  {tier.options.map((o, i) => (
                    <OptionRow key={`${o.provider}-${o.region}`} option={o} rank={i} tier={tier} signedIn={!!user}
                      onLaunch={() => setLaunch({ provider: o.provider, region: o.region, shapeId: o.shapeId, quality: TIER_QUALITY[tier.id], game: result.game?.title || game.trim() || undefined, spot: o.spot })} />
                  ))}
                </ol>
              )}
              <p className="text-[0.68rem] text-slate-500">
                Ping is estimated from distance; real numbers depend on your internet provider. Price = machine{spot ? ' (spot where offered)' : ''} + data streamed to you at {tier.resolution}{tier.fps} (~{tier.gbPerHour} GB/h). Estimates exclude tax and disk storage.
                {tier.overBudget > 0 && <> {tier.overBudget} more region{tier.overBudget === 1 ? '' : 's'} hidden over your budget.</>}
                {tier.tooFar > 0 && <> {tier.tooFar} far-away region{tier.tooFar === 1 ? '' : 's'} (over 80 ms) hidden.</>}
              </p>
            </section>
          )}
        </>
      )}

      {launch && <LaunchMachineModal preset={launch} onClose={() => setLaunch(null)} onLaunched={() => {}} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function OptionRow({ option: o, rank, tier, onLaunch, signedIn }: { option: Option; rank: number; tier: Tier; onLaunch: () => void; signedIn: boolean }) {
  const c = CLOUD[o.provider] || { color: '#94a3b8', letter: '?' };
  const same = (x: Option | null) => !!x && x.provider === o.provider && x.region === o.region;
  const tags = [rank === 0 ? 'Top pick' : null, same(tier.cheapest) ? 'Cheapest' : null, same(tier.closest) ? 'Closest' : null].filter(Boolean) as string[];
  return (
    <li className={`rounded-lg border p-2.5 sm:p-3 ${rank === 0 ? 'border-neon-magenta/50 bg-neon-magenta/[0.04]' : 'border-white/10 bg-white/[0.02]'}`}>
      <div className="flex items-start gap-2.5">
        <span aria-hidden className="mt-0.5 shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-full text-[0.7rem] font-bold text-white" style={{ background: c.color }}>{c.letter}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-100 leading-tight">
            {o.regionName} <span className="text-slate-500 text-xs">· {o.providerLabel}</span>
            {tags.map((t) => <span key={t} className="ml-1.5 align-middle whitespace-nowrap text-[0.6rem] uppercase tracking-label rounded border border-neon-magenta/40 text-neon-magenta px-1">{t}</span>)}
          </p>
          <p className="text-[0.7rem] text-slate-500 truncate">{o.region} · {o.shapeLabel}</p>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs tabular-nums">
            <span><span className={RATING[o.latencyRating].className}>~{o.latencyMs} ms</span> <span className="text-slate-500">{RATING[o.latencyRating].label}</span></span>
            <span className="text-slate-100 font-semibold">{money(o.totalPerHour)}/h</span>
            <span className="text-slate-500">{money(o.computePerHour)} {o.spot ? o.spotLabel.toLowerCase() : 'machine'} + {money(o.egressPerHour)} data</span>
          </div>
        </div>
        {signedIn ? (
          <button type="button" onClick={onLaunch} className={`shrink-0 text-xs font-mono px-2.5 py-1.5 ${rank === 0 ? 'btn-neon-magenta' : 'btn-neon'}`}>LAUNCH</button>
        ) : (
          <Link href="/login?next=/recommendations" className="shrink-0 btn-neon text-xs font-mono px-2.5 py-1.5">SIGN IN</Link>
        )}
      </div>
    </li>
  );
}

/** City / country search box with a suggestion list (keyboard: ↑ ↓ Enter Esc). */
function PlaceSearch({ onPick }: { onPick: (p: ChosenPlace) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { signal: ctrl.signal }).then((x) => x.json());
        setResults(r.results || []);
        setActive(0);
        setOpen(true);
      } catch { /* aborted or offline */ } finally { setBusy(false); }
    }, 250);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);

  const pick = (p: Place) => {
    onPick({ label: placeLabel(p), lat: p.lat, lng: p.lng, source: 'search' });
    setQ('');
    setResults([]);
    setOpen(false);
  };

  return (
    <div className="relative">
      <input
        id="recon-place" type="search" value={q} autoComplete="off" spellCheck={false}
        placeholder="City or country — e.g. Melbourne, Japan"
        role="combobox" aria-expanded={open && results.length > 0} aria-controls="recon-place-list" aria-autocomplete="list"
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); setOpen(true); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); if (results[active]) pick(results[active]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
        className="input-neon w-full px-3 py-2 rounded font-mono text-sm"
      />
      {busy && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[0.7rem] text-slate-500">…</span>}
      {open && q.trim().length >= 2 && (
        <ul id="recon-place-list" role="listbox" className="absolute z-30 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded border border-neon-cyan/30 bg-cyber-dark shadow-xl">
          {results.length === 0 && !busy && <li className="px-3 py-2 text-xs text-slate-500">No matches — try the nearest big city.</li>}
          {results.map((p, i) => (
            <li key={`${p.name}-${p.lat}-${p.lng}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(p); }}
              onMouseEnter={() => setActive(i)}
              className={`px-3 py-2 cursor-pointer text-sm ${i === active ? 'bg-neon-cyan/10 text-slate-100' : 'text-slate-300'}`}>
              {p.kind === 'country' ? (
                <>{p.country} <span className="text-[0.7rem] text-slate-500">· country</span></>
              ) : (
                <>{p.name}<span className="text-slate-500">{p.admin ? `, ${p.admin}` : ''}, {p.country}</span></>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One-tap city chips shown before any location is set. */
function QuickPick({ city, onPick }: { city: string; onPick: (p: ChosenPlace) => void }) {
  const go = async () => {
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(city)}`).then((x) => x.json()).catch(() => ({ results: [] }));
    const p: Place | undefined = r.results?.find((x: Place) => x.kind === 'city') || r.results?.[0];
    if (p) onPick({ label: placeLabel(p), lat: p.lat, lng: p.lng, source: 'search' });
  };
  return <button type="button" onClick={go} className="text-xs rounded border border-white/15 px-2 py-1 text-slate-300 hover:border-neon-cyan/50">{city}</button>;
}

/** "Enter coordinates" disclosure for exact lat/lng. */
function CoordinatesEditor({ place, onSet }: { place: ChosenPlace | null; onSet: (p: ChosenPlace) => void }) {
  const [open, setOpen] = useState(false);
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const valid = lat !== '' && lng !== '' && Math.abs(parseFloat(lat)) <= 90 && Math.abs(parseFloat(lng)) <= 180;
  if (!open) {
    return (
      <button type="button" className="text-slate-400 hover:text-neon-cyan hover:underline"
        onClick={() => { setLat(place ? place.lat.toFixed(4) : ''); setLng(place ? place.lng.toFixed(4) : ''); setOpen(true); }}>
        Enter coordinates
      </button>
    );
  }
  return (
    <form className="flex w-full flex-wrap items-center gap-2"
      onSubmit={(e) => { e.preventDefault(); if (valid) { onSet({ label: 'Custom coordinates', lat: parseFloat(lat), lng: parseFloat(lng), source: 'manual' }); setOpen(false); } }}>
      <input aria-label="Latitude" type="number" step="0.0001" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="lat" className="input-neon w-24 px-2 py-1 rounded font-mono text-xs" />
      <input aria-label="Longitude" type="number" step="0.0001" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="lng" className="input-neon w-24 px-2 py-1 rounded font-mono text-xs" />
      <button type="submit" disabled={!valid} className="btn-neon text-xs px-2 py-1 disabled:opacity-40">Set</button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-slate-400 hover:text-slate-100">Cancel</button>
    </form>
  );
}
