'use client';

/**
 * ============================================================================
 * app/recommendations/page.tsx — GAME RECON: WHERE TO PLAY, AND ON WHAT
 * ============================================================================
 *
 * 1. Where are you? Type a city or country ("Melbourne", "Japan",
 *    "Portland, Oregon"), use your internet connection's location, or enter
 *    coordinates. Names become lat/lng via app/api/geocode.
 * 2. What do you play? A broad category (competitive, modern AAA,
 *    demanding/4K, classic, indie) — no game name needed. Each category
 *    sets the hardware tier AND what matters most when ranking regions:
 *    esports → lowest ping; indie → lowest price; AAA → balanced.
 * 3. General first, specific if wanted: the tier cards — GOOD (T4,
 *    1080p60), BETTER (L4/A10G, 1440p60), BEST (more GPU + CPU, up to 4K60)
 *    — can be switched directly, and "Fine-tune" holds a specific game,
 *    a budget and the sort order.
 * 4. Pricing: RELIABLE (on-demand) or SPOT — the clouds' spare capacity at a
 *    steep discount, which the cloud can take back at short notice. Spot
 *    makes big machines cheap, so the page suggests "going large" when a
 *    bigger tier on spot costs less than a smaller one on-demand, and flags
 *    LIVE deep discounts (AWS / Azure publish live spot data).
 * 4. The list ranks every cloud region for that tier; [ LAUNCH ] opens the
 *    launch form pre-filled with that exact cloud, region and machine.
 *
 * Numbers come from GET /api/recon (src/services/ReconService.ts), which
 * reads the same price catalogs as the launch form. Results refresh by
 * themselves whenever an input changes.
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usd } from '@/lib/money';
import CloudLogo from '@/components/CloudLogo';
import { apiFetch, ApiError } from '@/lib/auth';
import { ACCESS_STYLE, fetchRegionAccess, indexAccess, statusFor, type RegionAccess } from '@/lib/regionAccess';
import { GPU_COMPARE, TIER_CONSUMER } from '@/lib/gpuCompare';
import { useAuth } from '@/components/AuthProvider';
import LaunchMachineModal, { type LaunchPreset } from '@/components/LaunchMachineModal';
import { placeLabel, type Place } from '@/lib/places';

type TierId = 'good' | 'better' | 'best';
type Priority = 'latency' | 'balanced' | 'price';
type Rating = 'excellent' | 'good' | 'fair' | 'poor';

interface Option {
  provider: string; providerLabel: string; region: string; regionName: string;
  shapeId: string; shapeLabel: string; gpuModel: string; vcpus: number; memoryGb: number;
  latencyMs: number; latencyRating: Rating;
  computePerHour: number; spot: boolean; spotLabel: string; egressPerHour: number; totalPerHour: number;
  onDemandPerHour: number;
  spotOffer: SpotOffer | null;
}
type Deal = 'deep' | 'good' | null;
interface SpotOffer {
  spotPerHour: number; onDemandPerHour: number; discountPct: number; totalPerHour: number;
  source: 'live' | 'fixed' | 'estimate'; interruption: { label: string; level: number } | null; onReclaim: string; deal: Deal;
}
interface PriceFrom { totalPerHour: number; regionName: string; providerLabel: string }
interface Tier {
  id: TierId; label: string; gpuClass: string; gpuShort: string; resolution: string; fps: number; gbPerHour: number; bestFor: string;
  options: Option[]; totalOptions: number; overBudget: number; tooFar: number; closest: Option | null; cheapest: Option | null;
  offeredBy: string[]; notOfferedBy: string[];
  onDemandFrom: PriceFrom | null;
  spotFrom: (PriceFrom & { discountPct: number; deal: Deal; source: string }) | null;
  bestDeal: { discountPct: number; regionName: string; providerLabel: string; deal: Deal } | null;
}
interface ReconResult {
  game: { title: string; gpuClass: string; suggestedTier: TierId } | null;
  gameNotFound: boolean; games: string[]; tiers: Tier[];
}
interface ChosenPlace { label: string; lat: number; lng: number; source: 'search' | 'ip' | 'gps' | 'manual' }

const RATING: Record<Rating, { label: string; className: string }> = {
  excellent: { label: 'Excellent', className: 'text-neon-lime' },
  good: { label: 'Good', className: 'text-neon-cyan' },
  fair: { label: 'Fair', className: 'text-neon-amber' },
  poor: { label: 'Laggy', className: 'text-neon-pink' },
};
/**
 * Catch-all game categories. Each one encodes the deciding factor for that
 * kind of game: the hardware it needs (tier) and what to optimise for when
 * choosing a region (priority).
 */
const CATEGORIES: Array<{ id: string; label: string; examples: string; tier: TierId; priority: Priority; why: string }> = [
  { id: 'competitive', label: 'Competitive', examples: 'CS2, Dota 2, Overwatch 2, Street Fighter 6', tier: 'good', priority: 'latency',
    why: 'Every millisecond counts, and these run fast on a T4 — so the closest region wins, price second. (Kernel anti-cheat games like Valorant or Fortnite can’t run on these Linux machines.)' },
  { id: 'modern-aaa', label: 'Modern AAA', examples: 'Cyberpunk 2077, Elden Ring, Starfield', tier: 'better', priority: 'balanced',
    why: 'Needs a current GPU for 1440p — the best-value region with a good ping.' },
  { id: 'demanding', label: 'Demanding / 4K', examples: 'Flight Simulator, Baldur’s Gate 3, big sims & strategy', tier: 'best', priority: 'balanced',
    why: 'Heavy on GPU and CPU — the most powerful machines, at a good ping.' },
  { id: 'classic', label: 'Classic', examples: 'Skyrim, The Witcher 3, Fallout 4, older AAA', tier: 'good', priority: 'balanced',
    why: 'A T4 runs these at 1080p60 — no need to pay for more; good ping, then lowest price.' },
  { id: 'indie', label: 'Indie & casual', examples: 'Hades, Stardew Valley, Minecraft, turn-based', tier: 'good', priority: 'price',
    why: 'Light on hardware and forgiving of a little lag — the cheapest region that’s still playable.' },
];
// Games whose anti-cheat blocks Linux / Proton (the machines run Ubuntu +
// Steam Proton), so they won't start on these machines at all.
const ANTI_CHEAT_BLOCKED = /valorant|fortnite|apex legends|pubg|league of legends|rainbow six|destiny 2|call of duty|warzone|battlefield|gta online|roblox/i;

const PRIORITY_LABEL: Record<Priority, string> = { latency: 'Lowest ping', balanced: 'Balanced', price: 'Lowest price' };

// Tier → the launch form's streaming quality.
const TIER_QUALITY: Record<TierId, string> = { good: 'good', better: 'high', best: 'ultra' };
const QUICK_PICKS = ['Sydney', 'Singapore', 'Tokyo', 'London', 'New York', 'Los Angeles'];
const STORE_KEY = 'recon.place';

const money = (n: number) => usd(n);

// Discount highlight: deep (≥ 65% off, live) / good (≥ 55%, live) / plain.
const DEAL_STYLE: Record<'deep' | 'good' | 'plain', { label: string; className: string }> = {
  deep: { label: 'Deep discount', className: 'border-neon-lime/60 bg-neon-lime/10 text-neon-lime' },
  good: { label: 'Good deal', className: 'border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan' },
  plain: { label: '', className: 'border-white/15 text-slate-300' },
};
function DiscountBadge({ pct, deal, source, compact }: { pct: number; deal: Deal; source: string; compact?: boolean }) {
  const st = DEAL_STYLE[deal || 'plain'];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1 text-[0.62rem] uppercase tracking-label tabular-nums ${st.className}`}
      title={source === 'live' ? 'Live spot price from the cloud' : source === 'fixed' ? 'This cloud always gives this discount' : 'Estimated discount (no live feed for this cloud)'}>
      {deal === 'deep' && <span aria-hidden>🔥</span>}−{pct}%{!compact && st.label ? ` · ${st.label}` : ''}{source === 'estimate' ? ' est.' : ''}
    </span>
  );
}

export default function RecommendationsPage() {
  const { user } = useAuth();
  const [place, setPlace] = useState<ChosenPlace | null>(null);
  const [game, setGame] = useState('');
  const [budget, setBudget] = useState('');
  const [spot, setSpot] = useState(false);
  const [categoryId, setCategoryId] = useState('modern-aaa');
  const category = CATEGORIES.find((c) => c.id === categoryId)!;
  const [sortOverride, setSortOverride] = useState<Priority | null>(null); // set in Fine-tune
  const priority = sortOverride || category.priority;
  const [fineTune, setFineTune] = useState(false);
  const [tierId, setTierId] = useState<TierId>(category.tier);
  const [result, setResult] = useState<ReconResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launch, setLaunch] = useState<LaunchPreset | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateNote, setLocateNote] = useState<string | null>(null);
  // Can your accounts launch in each region? (quota / region on / keys). Every
  // option stays listed either way — a badge says what setup it still needs.
  const [access, setAccess] = useState<Record<string, RegionAccess> | null>(null);
  useEffect(() => {
    if (!user) { setAccess(null); return; }
    fetchRegionAccess().then((r) => setAccess(indexAccess(r))).catch(() => setAccess(null));
  }, [user]);

  const pickCategory = (id: string) => {
    const c = CATEGORIES.find((x) => x.id === id)!;
    setCategoryId(id);
    setTierId(c.tier);
    setSortOverride(null);
  };

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
      const qs = new URLSearchParams({ lat: String(place.lat), lng: String(place.lng), priority });
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
  }, [place, budget, spot, game, priority]);

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

        <div>
          <p id="recon-cat" className="block text-xs font-bold text-neon-cyan mb-1.5 font-mono">WHAT_DO_YOU_PLAY</p>
          <div role="radiogroup" aria-labelledby="recon-cat" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {CATEGORIES.map((c) => {
              const on = c.id === categoryId;
              return (
                <button key={c.id} type="button" role="radio" aria-checked={on} onClick={() => pickCategory(c.id)}
                  className={`text-left rounded border px-2.5 py-2 transition ${on ? 'border-neon-cyan bg-neon-cyan/[0.07]' : 'border-white/10 hover:border-white/25'}`}>
                  <span className={`block text-sm font-semibold ${on ? 'text-neon-cyan' : 'text-slate-200'}`}>{c.label}</span>
                  <span className="text-[0.68rem] text-slate-500 leading-snug line-clamp-1 sm:line-clamp-2">{c.examples}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            <span className="text-slate-200">{category.label}:</span> {category.why}
          </p>
        </div>

        {/* ---- Pricing: reliable or spot ---- */}
        <div>
          <p id="recon-pricing" className="block text-xs font-bold text-neon-cyan mb-1.5 font-mono">PRICING</p>
          <div role="radiogroup" aria-labelledby="recon-pricing" className="grid grid-cols-2 gap-2">
            {[
              { on: false, title: 'Reliable', sub: 'On-demand · never interrupted' },
              { on: true, title: 'Spot · big & cheap', sub: 'Up to 90% off · can be reclaimed' },
            ].map((m) => (
              <button key={m.title} type="button" role="radio" aria-checked={spot === m.on} onClick={() => setSpot(m.on)}
                className={`text-left rounded border px-2.5 py-2 transition ${spot === m.on ? (m.on ? 'border-neon-lime bg-neon-lime/[0.07]' : 'border-neon-cyan bg-neon-cyan/[0.07]') : 'border-white/10 hover:border-white/25'}`}>
                <span className={`block text-sm font-semibold ${spot === m.on ? (m.on ? 'text-neon-lime' : 'text-neon-cyan') : 'text-slate-200'}`}>{m.title}</span>
                <span className="text-[0.68rem] text-slate-500 leading-snug line-clamp-1 sm:line-clamp-none">{m.sub}</span>
              </button>
            ))}
          </div>
          {spot ? (
            <p className="mt-2 text-xs text-slate-400">
              <span className="text-neon-amber">⚠ Not guaranteed:</span> spot machines run on the cloud’s spare hardware for 50–90% less, but the cloud can reclaim them at short notice — great for casual sessions, risky mid-match. AWS, Google and Azure <em>stop</em> the machine and keep your disk; Oracle <em>deletes</em> it.
            </p>
          ) : (() => {
            const deal = result?.tiers.map((t) => t.bestDeal).filter(Boolean).sort((a, b) => b!.discountPct - a!.discountPct)[0];
            return deal ? (
              <p className="mt-2 text-xs text-slate-400">
                <DiscountBadge pct={deal.discountPct} deal={deal.deal} source="live" compact /> live spot price right now in {deal.regionName} ({deal.providerLabel}).{' '}
                <button type="button" onClick={() => setSpot(true)} className="text-neon-lime hover:underline">See spot prices →</button>
              </p>
            ) : null;
          })()}
        </div>

        {/* ---- Specific, only if wanted ---- */}
        <div>
          <button type="button" onClick={() => setFineTune((v) => !v)} aria-expanded={fineTune}
            className="text-left text-xs text-slate-400 hover:text-neon-cyan">
            {fineTune ? '▾' : '▸'} Fine-tune <span className="text-slate-500">— specific game, budget, sort order{(game.trim() || budget || sortOverride) ? ' · active' : ''}</span>
          </button>
          {fineTune && (
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-[2fr,1fr] gap-3 items-end">
              <div className="col-span-2 sm:col-span-1">
                <label htmlFor="recon-game" className="block text-xs font-bold text-neon-cyan mb-1.5 font-mono">SPECIFIC_GAME</label>
                <input id="recon-game" list="recon-games" value={game} onChange={(e) => setGame(e.target.value)} placeholder="e.g. Elden Ring"
                  className="input-neon w-full px-3 py-2 rounded font-mono text-sm" autoComplete="off" />
                <datalist id="recon-games">{result?.games.map((g) => <option key={g} value={g} />)}</datalist>
              </div>
              <div>
                <label htmlFor="recon-budget" className="block text-xs font-bold text-neon-cyan mb-1.5 font-mono">MAX_$/HOUR</label>
                <input id="recon-budget" type="number" inputMode="decimal" min="0" step="0.05" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="any"
                  className="input-neon w-full px-3 py-2 rounded font-mono text-sm" />
              </div>
              <div className="col-span-2">
                <p id="recon-sort" className="block text-xs font-bold text-neon-cyan mb-1.5 font-mono">SORT_BY</p>
                <div role="radiogroup" aria-labelledby="recon-sort" className="inline-flex rounded border border-white/10 overflow-hidden">
                  {(['latency', 'balanced', 'price'] as Priority[]).map((p) => (
                    <button key={p} type="button" role="radio" aria-checked={priority === p} onClick={() => setSortOverride(p === category.priority ? null : p)}
                      className={`px-2.5 py-1.5 text-xs border-r last:border-r-0 border-white/10 ${priority === p ? 'bg-neon-cyan/15 text-neon-cyan' : 'text-slate-400 hover:text-slate-200'}`}>
                      {PRIORITY_LABEL[p]}
                    </button>
                  ))}
                </div>
              </div>
              {ANTI_CHEAT_BLOCKED.test(game) && (
                <p className="col-span-2 text-xs text-neon-pink">⚠ {game.trim()} uses anti-cheat that blocks Linux, so it won’t run on these machines (they run Steam on Linux via Proton). Check protondb.com for a game before launching.</p>
              )}
              {result?.gameNotFound && game.trim() && (
                <p className="col-span-2 text-xs text-slate-400">“{game.trim()}” isn’t in the game library yet — the category above still applies{result.games.length ? ` (known: ${result.games.join(', ')})` : ''}.</p>
              )}
            </div>
          )}
        </div>
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
              const suggested = (result.game?.suggestedTier || category.tier) === t.id;
              return (
                <button key={t.id} type="button" role="radio" aria-checked={selected} onClick={() => setTierId(t.id)}
                  className={`relative text-left rounded-lg border p-2 sm:p-3 transition ${selected ? 'border-neon-cyan bg-neon-cyan/[0.07]' : 'border-white/10 hover:border-white/25'}`}>
                  {suggested && <span className="absolute -top-2 right-1.5 text-[0.6rem] rounded bg-cyber-dark border border-neon-magenta/60 text-neon-magenta px-1 leading-4">★ PICK</span>}
                  <span className={`block font-mono font-bold text-sm tracking-label ${selected ? 'text-neon-cyan' : 'text-slate-200'}`}>{t.label.toUpperCase()}</span>
                  <span className="block text-[0.7rem] text-slate-400">{t.resolution}{t.fps}</span>
                  <span className="block text-[0.7rem] text-slate-500 truncate" title={t.gpuClass}>{t.gpuShort}</span>
                  <span className="block text-[0.66rem] text-slate-500 truncate" title="Rough gaming-PC equivalent (datacenter GPUs differ)">{TIER_CONSUMER[t.id]}</span>
                  <span className="block mt-1 text-sm text-slate-100 tabular-nums">{pick ? <>{money(pick.totalPerHour)}<span className="text-slate-500 text-[0.7rem]">/h</span></> : <span className="text-slate-500 text-xs">over budget</span>}</span>
                  {pick && <span className={`block text-[0.7rem] tabular-nums ${RATING[pick.latencyRating].className}`}>~{pick.latencyMs} ms</span>}
                  {spot && pick?.spotOffer && pick.spot ? (
                    <span className="block mt-1"><DiscountBadge pct={pick.spotOffer.discountPct} deal={pick.spotOffer.deal} source={pick.spotOffer.source} compact /></span>
                  ) : !spot && t.spotFrom ? (
                    <span className="block mt-1 text-[0.66rem] text-slate-500 tabular-nums">spot {money(t.spotFrom.totalPerHour)}{t.spotFrom.deal === 'deep' ? ' 🔥' : ''}</span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <GoLarge tiers={result.tiers} tierId={tierId} spot={spot} onSwitch={(t, useSpot) => { setTierId(t); setSpot(useSpot); }} />

          {tier && (
            <section aria-live="polite" className="space-y-2 sm:space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-xs text-slate-400">
                  <span className="text-slate-200 font-semibold">{tier.label}:</span> {tier.gpuClass} · {tier.resolution}{tier.fps} · {tier.bestFor}.
                  {(result.game?.suggestedTier || category.tier) === tier.id && <> Suggested for {result.game?.title || category.label}.</>}
                  {' '}Sorted by {PRIORITY_LABEL[priority].toLowerCase()}.
                  {tier.notOfferedBy.length > 0 && <> Not offered on {tier.notOfferedBy.join(' or ')}.</>}
                </p>
                {loading && <span className="text-[0.7rem] text-neon-cyan animate-pulse">updating…</span>}
              </div>
              <GpuCompareNote />

              {access && tier.options.length > 0 && (() => {
                const ok = (o: Option) => { const a = access[`${o.provider}:${o.region}`]; return !!a && statusFor(a, o.gpuModel) === 'ready'; };
                const firstReady = tier.options.find(ok);
                if (ok(tier.options[0])) return null;
                return (
                  <p className="text-[0.72rem] text-neon-amber">
                    ! The top pick needs setup on your account first.{' '}
                    {firstReady
                      ? <>Best one you can launch right now: <span className="text-slate-100">{firstReady.regionName} ({firstReady.providerLabel})</span>, #{tier.options.indexOf(firstReady) + 1} below.</>
                      : <>None of these are ready yet.</>}{' '}
                    <Link href="/regions" className="text-neon-cyan hover:underline">See your regions</Link>
                  </p>
                );
              })()}
              {tier.options.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/15 p-4 text-sm text-slate-400">
                  Nothing in this tier fits {money(parseFloat(budget) || 0)}/hour.{tier.cheapest && <> Cheapest is {money(tier.cheapest.totalPerHour)}/h in {tier.cheapest.regionName} ({tier.cheapest.providerLabel}).</>}
                </div>
              ) : (
                <ol className="space-y-2">
                  {tier.options.map((o, i) => (
                    <OptionRow key={`${o.provider}-${o.region}`} option={o} rank={i} tier={tier} signedIn={!!user}
                      access={access?.[`${o.provider}:${o.region}`]}
                      showSpot={spot}
                      onLaunch={() => setLaunch({ provider: o.provider, region: o.region, shapeId: o.shapeId, quality: TIER_QUALITY[tier.id], game: result.game?.title || game.trim() || undefined, spot: o.spot })} />
                  ))}
                </ol>
              )}
              <p className="text-[0.68rem] text-slate-500">
                Ping is estimated from distance; real numbers depend on your internet provider. Price = machine{spot ? ' (spot)' : ''} + data streamed to you at {tier.resolution}{tier.fps} (~{tier.gbPerHour} GB/h). Estimates exclude tax and disk storage.{spot && ' Spot discounts marked “est.” are our assumption (Google publishes no live feed); others are live from the cloud or, for Oracle, its fixed 50%.'}
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

function OptionRow({ option: o, rank, tier, onLaunch, signedIn, showSpot, access }: { option: Option; rank: number; tier: Tier; onLaunch: () => void; signedIn: boolean; showSpot: boolean; access?: RegionAccess }) {
  const so = o.spotOffer;
  const same = (x: Option | null) => !!x && x.provider === o.provider && x.region === o.region;
  const tags = [rank === 0 ? 'Top pick' : null, same(tier.cheapest) ? 'Cheapest' : null, same(tier.closest) ? 'Closest' : null].filter(Boolean) as string[];
  return (
    <li className={`rounded-lg border p-2.5 sm:p-3 ${rank === 0 ? 'border-neon-magenta/50 bg-neon-magenta/[0.04]' : 'border-white/10 bg-white/[0.02]'}`}>
      <div className="flex items-start gap-2.5">
        <CloudLogo provider={o.provider} size={24} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-100 leading-tight">
            {o.regionName} <span className="text-slate-500 text-xs">· {o.providerLabel}</span>
            {tags.map((t) => <span key={t} className="ml-1.5 align-middle whitespace-nowrap text-[0.6rem] uppercase tracking-label rounded border border-neon-magenta/40 text-neon-magenta px-1">{t}</span>)}
          </p>
          <p className="text-[0.7rem] text-slate-500 truncate">{o.region} · {o.shapeLabel}{GPU_COMPARE[o.gpuModel] && <span className="text-slate-400" title={`Rough gaming-PC equivalent of the ${o.gpuModel}: ${GPU_COMPARE[o.gpuModel].consumer}. Datacenter GPUs run lower clocks and differ in drivers; an idea only.`}> · {GPU_COMPARE[o.gpuModel].short}</span>}</p>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs tabular-nums">
            <span><span className={RATING[o.latencyRating].className}>~{o.latencyMs} ms</span> <span className="text-slate-500">{RATING[o.latencyRating].label}</span></span>
            <span className="text-slate-100 font-semibold">{money(o.totalPerHour)}/h</span>
            <span className="text-slate-500">{money(o.computePerHour)} {o.spot ? o.spotLabel.toLowerCase() : 'machine'} + {money(o.egressPerHour)} data</span>
          </div>
          {so && (showSpot && o.spot ? (
            // Spot mode: how big the discount is, and how "unsecured" it is.
            <div className="mt-1.5 space-y-0.5 text-[0.7rem]">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <DiscountBadge pct={so.discountPct} deal={so.deal} source={so.source} />
                <span className="text-slate-500 tabular-nums">vs <span className="line-through">{money(so.onDemandPerHour)}</span> on-demand</span>
              </p>
              <p className="text-slate-500">
                {so.interruption
                  ? <>Reclaimed <span className={so.interruption.level >= 3 ? 'text-neon-amber' : 'text-slate-300'}>{so.interruption.label}</span> of the time here{so.interruption.level >= 3 ? ' — expect interruptions' : ''}. </>
                  : null}
                <span className={o.provider === 'oracle' ? 'text-neon-pink' : ''}>{so.onReclaim}</span>
              </p>
            </div>
          ) : !showSpot && so.deal ? (
            // Reliable mode: still point out a live spot bargain on this exact machine.
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[0.7rem] text-slate-500 tabular-nums">
              <DiscountBadge pct={so.discountPct} deal={so.deal} source={so.source} compact /> spot here: {money(so.totalPerHour)}/h
            </p>
          ) : null)}
          {access && <AccessNote access={access} spot={o.spot} rank={rank} gpu={o.gpuModel} />}
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

/** Whether your account can launch here — shown on every option, never filtered. */
function AccessNote({ access: a, spot, rank, gpu }: { access: RegionAccess; spot: boolean; rank: number; gpu: string }) {
  const status = statusFor(a, gpu);
  const st = ACCESS_STYLE[status];
  const spotShort = spot && status === 'ready' && a.spotReady === false;
  const spotOnly = !spot && status === 'ready' && a.onDemandReady === false;
  if (spotOnly) {
    return (
      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.7rem] text-slate-400">
        <span className={`inline-flex items-center gap-1 rounded border px-1 uppercase tracking-label text-[0.6rem] ${ACCESS_STYLE['no-quota'].className}`}><span aria-hidden className="font-bold">!</span>Spot only</span>
        <span>Your quota here only covers spot machines — turn on spot, or</span>
        <Link href="/regions" className="text-neon-cyan hover:underline whitespace-nowrap">raise on-demand</Link>
      </p>
    );
  }
  if (status === 'ready' && !spotShort) {
    return <p className="mt-1.5 text-[0.7rem] text-neon-lime"><span aria-hidden>✓</span> Ready — your account can launch here</p>;
  }
  const why = spotShort ? 'On-demand is ready, but your spot quota here is too low'
    : status === 'no-quota' && a.status === 'ready' ? `${rank === 0 ? 'Best option' : 'Would work'}, but you have no ${gpu} quota here yet (other GPUs are ready)`
    : a.status === 'no-quota' ? `${rank === 0 ? 'Best option' : 'Would work'}, but you have no GPU quota here yet`
    : a.status === 'not-enabled' ? `${rank === 0 ? 'Best option' : 'Would work'}, but this region isn’t switched on for your account`
    : a.status === 'not-connected' ? 'You haven’t connected this cloud yet'
    : 'Couldn’t check your access here';
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.7rem] text-slate-400">
      <span className={`inline-flex items-center gap-1 rounded border px-1 uppercase tracking-label text-[0.6rem] ${spotShort ? ACCESS_STYLE['no-quota'].className : st.className}`}>
        <span aria-hidden className="font-bold">{spotShort ? '!' : st.icon}</span>{spotShort ? 'Spot quota' : st.short}
      </span>
      <span>{why} —</span>
      <Link href={a.status === 'not-connected' ? '/settings' : '/regions'} className="text-neon-cyan hover:underline whitespace-nowrap">
        {a.status === 'not-connected' ? 'connect it' : a.status === 'unknown' ? 'see why' : 'how to fix'}
      </Link>
    </p>
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

/**
 * "Go large for less": when a bigger tier on spot costs no more than the
 * selected tier (or GOOD) on-demand, say so — that's the point of spot.
 */
function GoLarge({ tiers, tierId, spot, onSwitch }: { tiers: Tier[]; tierId: TierId; spot: boolean; onSwitch: (t: TierId, spot: boolean) => void }) {
  const order: TierId[] = ['good', 'better', 'best'];
  const current = tiers.find((t) => t.id === tierId);
  if (!current?.onDemandFrom) return null;
  // Biggest tier above the current one whose spot price beats the current tier on-demand.
  const bigger = order.slice(order.indexOf(tierId) + 1).reverse()
    .map((id) => tiers.find((t) => t.id === id))
    .find((t) => t?.spotFrom && t.spotFrom.totalPerHour <= current.onDemandFrom!.totalPerHour);
  if (!bigger?.spotFrom) return null;
  const saving = current.onDemandFrom.totalPerHour - bigger.spotFrom.totalPerHour;
  return (
    <div className="rounded-lg border border-neon-lime/40 bg-neon-lime/[0.05] px-3 py-2.5 text-xs text-slate-300 flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="min-w-0 flex-1">
        <span className="text-neon-lime font-semibold">Go large for less:</span>{' '}
        {bigger.label.toUpperCase()} ({bigger.gpuShort}, {bigger.resolution}{bigger.fps}) on spot in {bigger.spotFrom.regionName} ({bigger.spotFrom.providerLabel}) is <span className="text-slate-100 tabular-nums">{money(bigger.spotFrom.totalPerHour)}/h</span>
        {' '}— {saving > 0.005 ? <>{money(saving)}/h less than</> : 'about the same as'} {current.label.toUpperCase()} on-demand ({money(current.onDemandFrom.totalPerHour)}/h).
        {' '}<DiscountBadge pct={bigger.spotFrom.discountPct} deal={bigger.spotFrom.deal} source={bigger.spotFrom.source} compact />
        {' '}{/oracle/i.test(bigger.spotFrom.providerLabel)
          ? <span className="text-neon-pink">Oracle deletes the machine and its disk if it reclaims it.</span>
          : <span className="text-slate-500">Can be interrupted; your disk is kept.</span>}
      </p>
      <button type="button" onClick={() => onSwitch(bigger.id, true)} className="btn-neon-lime text-xs px-2.5 py-1.5 whitespace-nowrap">
        {spot ? `Switch to ${bigger.label}` : `Use spot ${bigger.label}`}
      </button>
    </div>
  );
}

/** "How does this compare to a gaming PC?" — rough consumer equivalents. */
function GpuCompareNote() {
  return (
    <details className="rounded border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-slate-400">
      <summary className="cursor-pointer text-slate-300">How do these GPUs compare to a gaming PC? <span className="text-slate-500">(rough idea)</span></summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left tabular-nums">
          <thead className="text-[0.62rem] uppercase tracking-label text-slate-500">
            <tr><th className="py-1 pr-3 font-normal">Cloud GPU</th><th className="py-1 pr-3 font-normal">≈ Gaming card</th><th className="py-1 pr-3 font-normal">vs RTX 3080 Ti</th><th className="py-1 pr-3 font-normal">Memory · power</th><th className="py-1 font-normal">Where</th></tr>
          </thead>
          <tbody>
            {Object.values(GPU_COMPARE).map((g) => (
              <tr key={g.gpu} className="border-t border-white/5">
                <td className="py-1 pr-3 text-slate-200 whitespace-nowrap">{g.gpu} <span className="text-slate-500">{g.chip}</span></td>
                <td className="py-1 pr-3 text-neon-cyan whitespace-nowrap">{g.consumer}</td>
                <td className="py-1 pr-3">{g.vs3080Ti}</td>
                <td className="py-1 pr-3 whitespace-nowrap">{g.vram} · {g.power}</td>
                <td className="py-1 text-slate-500">{g.clouds}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 leading-relaxed">
        Datacenter cards aren’t gaming cards: they run lower clocks within a tight power limit, have more memory, no monitor output (the machine streams a
        virtual screen) and server drivers, and cloud vCPUs are usually slower per core than a gaming PC’s. So these are ballpark equivalents from public
        benchmarks of the same chips — real results vary by game. None of the GPUs these clouds rent for gaming reaches an RTX 3080 Ti; the A10 / A10G
        come closest at roughly two-thirds of one. Streaming also adds a little lag and compression on top.
      </p>
      <p className="mt-2 leading-relaxed">
        <span className="text-neon-magenta">Big screen (experimental):</span> these GPUs normally stream at most 2560×1600. Tick “Big screen” when launching
        to get up to 4096×2160 (a 3440×1440 ultrawide at full size): AWS and Azure at no extra cost, Google with its paid “vWS” GPUs, not Oracle.
      </p>
    </details>
  );
}
