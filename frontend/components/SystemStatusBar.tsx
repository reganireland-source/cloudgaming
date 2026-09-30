'use client';
// ↑ Client component: it runs a timer and updates live in the browser.

/**
 * ============================================================================
 * frontend/components/SystemStatusBar.tsx — THE SIX STATUS LIGHTS
 * ============================================================================
 *
 * The thin strip under the header on every page:
 *   ● BACKEND  ● DATABASE  |  ● AWS  ● AZURE  ● GCP  ● ORACLE     TODAY · WTD · MTD …  Build info ›
 * (the spend figures: components/SpendTicker.tsx, shown while signed in)
 * Green = reachable (with the check time in ms), red = not, grey pulsing = still checking.
 *
 * HOW IT WORKS
 * ------------
 * Every 20 seconds it calls the backend's GET /api/status (answered by
 * src/api/routes/status.ts + src/services/StatusService.ts), which reports
 * the database and each cloud. The BACKEND light is decided HERE: if that
 * request fails entirely, the backend is unreachable, and every light goes red.
 *
 * REACT CONCEPTS USED
 * -------------------
 * - useState: a component's memory. `const [status, setStatus] = useState(x)`
 *   gives the current value and a function to change it; changing it makes
 *   React re-draw the component with the new value.
 * - useEffect: run code AFTER the component appears on screen — here, start
 *   polling. The function it returns runs when the component is removed
 *   ("cleanup"), which stops the timer.
 * ============================================================================
 */

import { useState, useEffect } from 'react';
import { apiUrl } from '@/lib/api';
import BuildInfoPanel from './BuildInfoPanel';
import SpendTicker from './SpendTicker';
import StatusDetailPanel, { type LightKey } from './StatusDetailPanel';

// These interfaces describe the JSON the backend sends. They mirror the ones
// in src/services/StatusService.ts — if you change one, change the other.
interface ServiceStatus {
  name: string;
  connected: boolean;
  latencyMs?: number;
  detail?: string;
  checkedAt: string;
}

interface SystemStatus {
  backend: ServiceStatus;
  database: ServiceStatus;
  providers: {
    aws: ServiceStatus;
    azure: ServiceStatus;
    gcp: ServiceStatus;
    oracle: ServiceStatus;
  };
}

// Short names for small screens.
const SHORT_LABEL: Record<string, string> = { Backend: 'API', Database: 'DB', Azure: 'AZ', Oracle: 'OCI' };

// How often to re-check, in milliseconds (20000 ms = 20 seconds).
const POLL_INTERVAL_MS = 20000;

/**
 * One light: a coloured dot, a label, and the check time when connected.
 * A small component used only in this file.
 *
 * `connected` is `boolean | null`: true = green, false = red, null = no
 * answer yet. `loading` true = still waiting for the first check (grey, pulsing).
 */
function Light({
  label,
  connected,
  loading,
  latencyMs,
  onClick,
}: {
  label: string;
  connected: boolean | null;
  loading: boolean;
  latencyMs?: number;
  onClick: () => void; // opens the stats panel for this light
}) {
  // Chained ternaries: loading ? grey : (connected ? green : red).
  const color = loading
    ? 'bg-slate-600'
    : connected
    ? 'bg-neon-lime'
    : 'bg-[#e5484d]';

  const glow = loading
    ? ''
    : connected
    ? 'shadow-[0_0_6px_1px_rgba(143,214,148,0.55)]'
    : 'shadow-[0_0_6px_1px_rgba(229,72,77,0.55)]';

  // `title` = the tooltip shown when you hover over the light.
  return (
    // A <button> so it's clickable AND reachable with the keyboard (Tab + Enter).
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded px-1 -mx-1 hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-1 focus-visible:outline-neon-cyan"
      title={`${label}: click for details${latencyMs !== undefined ? ` (${latencyMs}ms)` : ''}`}
    >
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${color} ${glow} ${
          loading ? 'animate-pulse' : ''
        }`}
      />
      {/* Full name from 640px wide, a short one below (e.g. "DB", "AZ"). */}
      <span className="text-[0.7rem] tracking-label text-slate-400 uppercase">
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">{SHORT_LABEL[label] || label}</span>
      </span>
      {!loading && connected && latencyMs !== undefined && (
        <span className="hidden xl:inline text-[0.66rem] text-slate-600 tabular-nums">{latencyMs}ms</span>
      )}
    </button>
  );
}

export default function SystemStatusBar() {
  // The component's memory (see "REACT CONCEPTS" above):
  const [status, setStatus] = useState<SystemStatus | null>(null);                  // last answer from /api/status
  const [backendReachable, setBackendReachable] = useState<boolean | null>(null);   // did that request work at all?
  const [loading, setLoading] = useState(true);                                     // still waiting for the first answer?
  const [panelOpen, setPanelOpen] = useState(false);                                // is the Build info pop-up showing?
  const [detailFor, setDetailFor] = useState<LightKey | null>(null);                // which light's stats panel is open

  // Runs once after the bar first appears (the empty [] at the end means
  // "no dependencies — don't re-run on re-renders").
  useEffect(() => {
    // Guard flag: if the component is removed while a request is still in
    // flight, don't try to update state afterwards (React warns about that).
    let cancelled = false;

    // Ask the backend for the current status and store the result.
    const fetchStatus = async () => {
      try {
        // `fetch` = the browser's built-in way to make a web request.
        // cache: 'no-store' = always ask the server, never reuse a stored copy.
        const response = await fetch(apiUrl('/status'), { cache: 'no-store' });
        // fetch only throws on NETWORK failure; an HTTP error like 500 still
        // "succeeds", so check response.ok (true for 200–299) ourselves.
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data: SystemStatus = await response.json();
        if (!cancelled) {
          setStatus(data);
          setBackendReachable(true);
        }
      } catch (error) {
        // Couldn't reach the backend: backend light red, and forget the old
        // status so the other lights don't show stale green. Common causes:
        // backend down, NEXT_PUBLIC_API_URL wrong/missing, or a CORS problem.
        if (!cancelled) {
          setBackendReachable(false);
          setStatus(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    // Check immediately, then every 20 s. setInterval returns an id we need
    // later to stop it.
    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);

    // Cleanup, run when the bar is removed: stop the timer, ignore late answers.
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    // No blur effect on this bar on purpose: CSS makes any "position: fixed"
    // child of a blurred (backdrop-filter) element position itself inside
    // that element, which squeezed the pop-ups into this 30px bar.
    // short:static = scrolls away on short screens (see layout.tsx).
    // z-40 keeps the bar under the nav's mobile menu. But its pop-ups live
    // inside this bar, so they can't rise above that z-40 on their own:
    // while one is open the bar is lifted over the nav (z-[70]).
    <div className={`sticky top-12 short:static ${panelOpen || detailFor ? 'z-[70]' : 'z-40'} border-b border-white/[0.05] bg-cyber-darker`}>
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-1.5 flex items-center justify-between gap-2 sm:gap-4">
        <div className="flex items-center gap-2.5 sm:gap-5 min-w-0 flex-wrap">
          {/* `status?.database.connected ?? null` below: `?.` = "if status
              exists" (it's null until the first answer), and `?? null` =
              "if that gave undefined, use null (= unknown)". */}
          <Light label="Backend"
            onClick={() => setDetailFor('backend')} connected={backendReachable} loading={loading} />
          <Light
            label="Database"
            onClick={() => setDetailFor('database')}
            connected={status?.database?.connected ?? null}
            loading={loading}
            latencyMs={status?.database?.latencyMs}
          />
          <div className="h-3 w-px bg-neon-cyan/20" />
          <Light
            label="AWS"
            onClick={() => setDetailFor('aws')}
            connected={status?.providers?.aws?.connected ?? null}
            loading={loading}
            latencyMs={status?.providers?.aws?.latencyMs}
          />
          <Light
            label="Azure"
            onClick={() => setDetailFor('azure')}
            connected={status?.providers?.azure?.connected ?? null}
            loading={loading}
            latencyMs={status?.providers?.azure?.latencyMs}
          />
          <Light
            label="GCP"
            onClick={() => setDetailFor('gcp')}
            connected={status?.providers?.gcp?.connected ?? null}
            loading={loading}
            latencyMs={status?.providers?.gcp?.latencyMs}
          />
          <Light
            label="Oracle"
            onClick={() => setDetailFor('oracle')}
            connected={status?.providers?.oracle?.connected ?? null}
            loading={loading}
            latencyMs={status?.providers?.oracle?.latencyMs}
          />
        </div>

        <div className="flex items-center gap-3 sm:gap-4 flex-shrink-0">
        <SpendTicker />
        <button
          onClick={() => setPanelOpen(true)}
          className="text-[0.7rem] tracking-label uppercase text-slate-500 hover:text-neon-cyan transition-colors flex-shrink-0"
          aria-label="Build info"
        >
          <span className="hidden sm:inline">Build info ›</span><span className="sm:hidden">ⓘ</span>
        </button>
        </div>
      </div>

      {/* The pop-up only exists while panelOpen is true. We pass it a
          function to call when it wants to close. */}
      {panelOpen && <BuildInfoPanel onClose={() => setPanelOpen(false)} />}
      {/* Clicking a light opens its live stats (components/StatusDetailPanel.tsx). */}
      {detailFor && <StatusDetailPanel initial={detailFor} onClose={() => setDetailFor(null)} />}
    </div>
  );
}
