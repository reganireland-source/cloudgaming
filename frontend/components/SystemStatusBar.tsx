'use client';

import { useState, useEffect } from 'react';
import { apiUrl } from '@/lib/api';
import BuildInfoPanel from './BuildInfoPanel';

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

const POLL_INTERVAL_MS = 20000;

function Light({
  label,
  connected,
  loading,
  latencyMs,
}: {
  label: string;
  connected: boolean | null;
  loading: boolean;
  latencyMs?: number;
}) {
  const color = loading
    ? 'bg-gray-500'
    : connected
    ? 'bg-neon-lime'
    : 'bg-red-500';

  const glow = loading
    ? ''
    : connected
    ? 'shadow-[0_0_6px_2px_rgba(0,255,65,0.6)]'
    : 'shadow-[0_0_6px_2px_rgba(239,68,68,0.6)]';

  return (
    <div className="flex items-center gap-1.5" title={latencyMs !== undefined ? `${latencyMs}ms` : undefined}>
      <span
        className={`inline-block w-2 h-2 rounded-full ${color} ${glow} ${
          loading ? 'animate-pulse' : ''
        }`}
      />
      <span className="text-[10px] font-mono tracking-wide text-gray-400 uppercase">
        {label}
      </span>
    </div>
  );
}

export default function SystemStatusBar() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [backendReachable, setBackendReachable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const fetchStatus = async () => {
      try {
        const response = await fetch(apiUrl('/status'), { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data: SystemStatus = await response.json();
        if (!cancelled) {
          setStatus(data);
          setBackendReachable(true);
        }
      } catch (error) {
        if (!cancelled) {
          setBackendReachable(false);
          setStatus(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="sticky top-20 z-40 border-b border-neon-cyan/20 bg-black/70 backdrop-blur-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-1.5 flex items-center justify-between gap-4 overflow-x-auto">
        <div className="flex items-center gap-4 sm:gap-5 flex-shrink-0">
          <Light label="Backend" connected={backendReachable} loading={loading} />
          <Light
            label="Database"
            connected={status?.database.connected ?? null}
            loading={loading}
            latencyMs={status?.database.latencyMs}
          />
          <div className="hidden sm:block h-3 w-px bg-neon-cyan/20" />
          <Light
            label="AWS"
            connected={status?.providers.aws.connected ?? null}
            loading={loading}
            latencyMs={status?.providers.aws.latencyMs}
          />
          <Light
            label="Azure"
            connected={status?.providers.azure.connected ?? null}
            loading={loading}
            latencyMs={status?.providers.azure.latencyMs}
          />
          <Light
            label="GCP"
            connected={status?.providers.gcp.connected ?? null}
            loading={loading}
            latencyMs={status?.providers.gcp.latencyMs}
          />
          <Light
            label="Oracle"
            connected={status?.providers.oracle.connected ?? null}
            loading={loading}
            latencyMs={status?.providers.oracle.latencyMs}
          />
        </div>

        <button
          onClick={() => setPanelOpen(true)}
          className="text-[10px] font-mono text-neon-cyan/60 hover:text-neon-cyan transition-colors flex-shrink-0"
        >
          [ BUILD_INFO ]
        </button>
      </div>

      {panelOpen && <BuildInfoPanel onClose={() => setPanelOpen(false)} />}
    </div>
  );
}
