'use client';

/**
 * ============================================================================
 * frontend/components/BuildInfoPanel.tsx — THE "BUILD INFO" POP-UP
 * ============================================================================
 *
 * Opened from "Build info ›" in the status bar. Shows exactly what's
 * deployed, side by side:
 *   FRONTEND — from /api/build-info on Vercel (app/api/build-info/route.ts)
 *   BACKEND  — from /api/status/version on Railway (src/api/routes/status.ts)
 * Most useful for answering "is my latest commit actually live?" — compare
 * the Git commit rows with `git log`.
 *
 * It's a MODAL: a dark overlay covering the page with a box on top.
 * Clicking the overlay closes it; clicking inside the box doesn't.
 * ============================================================================
 */

import { useState, useEffect } from 'react';
import { apiUrl } from '@/lib/api';

// Shapes of the two JSON answers (mirror the two server routes above).
interface FrontendBuildInfo {
  service: string;
  environment: string;
  nodeVersion: string;
  gitCommit: string | null;
  gitBranch: string | null;
  gitMessage: string | null;
  deploymentUrl: string | null;
  apiBaseUrl: string | null;
  instanceStartedAt: string;
}

interface BackendVersionInfo {
  service: string;
  version: string;
  environment: string;
  nodeVersion: string;
  gitCommit: string | null;
  gitBranch: string | null;
  railwayDeploymentId: string | null;
  railwayEnvironment: string | null;
  startedAt: string;
  uptimeSeconds: number;
}

/**
 * 3725 seconds -> "1h 2m 5s".
 * `%` is the remainder after division: 3725 % 3600 = 125 leftover seconds.
 */
function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

/** One "label ........ value" line. Empty values show as an em dash (—). */
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 border-b border-white/5 text-xs font-mono">
      <span className="text-gray-500">{label}</span>
      <span className="text-neon-lime text-right break-all">{value || '—'}</span>
    </div>
  );
}

/**
 * @param onClose function provided by the parent (SystemStatusBar) that hides
 *                this panel. `() => void` = a function taking nothing and
 *                returning nothing.
 */
export default function BuildInfoPanel({ onClose }: { onClose: () => void }) {
  const [frontend, setFrontend] = useState<FrontendBuildInfo | null>(null);
  const [backend, setBackend] = useState<BackendVersionInfo | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load both sets of info once, when the panel opens. Two separate
  // try/catch blocks so that one failing doesn't hide the other.
  useEffect(() => {
    const load = async () => {
      try {
        // A RELATIVE path on purpose: this route lives on the frontend
        // (Vercel) itself, unlike every other /api call, which uses apiUrl().
        const feRes = await fetch('/api/build-info', { cache: 'no-store' });
        setFrontend(await feRes.json());
      } catch {
        // frontend build-info route failing is unlikely, no fallback needed
      }

      try {
        const beRes = await fetch(apiUrl('/status/version'), { cache: 'no-store' });
        if (!beRes.ok) throw new Error(`HTTP ${beRes.status}`);
        setBackend(await beRes.json());
      } catch (error: any) {
        setBackendError(error.message || 'Failed to reach backend');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  return (
    // The overlay: "fixed inset-0" covers the whole window; clicking it closes.
    <div
      className="fixed inset-0 !m-0 bg-black/80 flex items-stretch sm:items-center justify-center z-50 p-0 sm:p-4"
      onClick={onClose}
    >
      {/* The box. Clicks "bubble up" from an element to its parents, so a
          click in here would also reach the overlay and close the panel.
          e.stopPropagation() stops that. */}
      <div
        className="bg-cyber-dark border border-neon-cyan/30 rounded-none sm:rounded-lg max-w-2xl w-full h-[100dvh] sm:h-auto sm:max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-neon-cyan/30 p-3 sm:p-5 flex items-center justify-between">
          <h2 className="text-sm tracking-label font-bold font-mono neon-text">[ BUILD_&_VERSION_INFO ]</h2>
          <button
            onClick={onClose}
            className="text-neon-cyan/60 hover:text-neon-cyan font-mono text-sm"
          >
            [ CLOSE ]
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center font-mono text-neon-cyan text-sm">
            &gt; LOADING_BUILD_INFO...
          </div>
        ) : (
          <div className="p-3 sm:p-5 space-y-4 sm:space-y-6">
            <div>
              <h3 className="text-sm font-bold font-mono text-neon-cyan mb-2">
                [ FRONTEND ]
              </h3>
              {frontend ? (
                <div>
                  <Row label="Service" value={frontend.service} />
                  <Row label="Environment" value={frontend.environment} />
                  <Row label="Node version" value={frontend.nodeVersion} />
                  <Row label="Git commit" value={frontend.gitCommit} />
                  <Row label="Git branch" value={frontend.gitBranch} />
                  <Row label="Git message" value={frontend.gitMessage} />
                  <Row label="API base URL" value={frontend.apiBaseUrl} />
                  <Row label="Instance started" value={frontend.instanceStartedAt} />
                </div>
              ) : (
                <p className="text-xs font-mono text-red-400">
                  Failed to load frontend build info
                </p>
              )}
            </div>

            <div>
              <h3 className="text-sm font-bold font-mono text-neon-magenta mb-2">
                [ BACKEND ]
              </h3>
              {backend ? (
                <div>
                  <Row label="Service" value={backend.service} />
                  <Row label="Version" value={backend.version} />
                  <Row label="Environment" value={backend.environment} />
                  <Row label="Node version" value={backend.nodeVersion} />
                  <Row label="Git commit" value={backend.gitCommit} />
                  <Row label="Git branch" value={backend.gitBranch} />
                  <Row label="Railway deployment" value={backend.railwayDeploymentId} />
                  <Row label="Railway environment" value={backend.railwayEnvironment} />
                  <Row label="Started at" value={backend.startedAt} />
                  <Row label="Uptime" value={formatUptime(backend.uptimeSeconds)} />
                </div>
              ) : (
                <p className="text-xs font-mono text-red-400">
                  {backendError || 'Failed to load backend version info'}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
