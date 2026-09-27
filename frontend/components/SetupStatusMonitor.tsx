'use client';

import { useState, useEffect } from 'react';

interface SetupStatus {
  machineId: string;
  stage: string;
  progress: number;
  message: string;
  sunshinePin?: string;
  sunshineUrl?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

const STAGE_LABELS: Record<string, { label: string; emoji: string }> = {
  initializing: { label: 'Initializing', emoji: '⚙️' },
  waiting_for_instance: { label: 'Waiting for Instance', emoji: '⏳' },
  installing_drivers: { label: 'Installing GPU Drivers', emoji: '🎮' },
  installing_cloudypad: { label: 'Installing CloudyPad', emoji: '☁️' },
  configuring_sunshine: { label: 'Configuring Sunshine', emoji: '🌞' },
  installing_clients: { label: 'Installing Gaming Clients', emoji: '🎯' },
  starting_service: { label: 'Starting Streaming Service', emoji: '▶️' },
  complete: { label: 'Complete', emoji: '✅' },
  failed: { label: 'Failed', emoji: '❌' },
};

interface SetupStatusMonitorProps {
  machineId: string;
  onComplete?: (status: SetupStatus) => void;
  onError?: (error: string) => void;
}

export default function SetupStatusMonitor({
  machineId,
  onComplete,
  onError,
}: SetupStatusMonitorProps) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let pollInterval: NodeJS.Timeout;

    const fetchStatus = async () => {
      try {
        const response = await fetch(`/api/setup-status/${machineId}`);
        const data = await response.json();
        setStatus(data);

        if (data.stage === 'complete') {
          if (onComplete) onComplete(data);
          clearInterval(pollInterval);
        } else if (data.stage === 'failed') {
          if (onError) onError(data.error || 'Setup failed');
          clearInterval(pollInterval);
        }

        setLoading(false);
      } catch (error) {
        console.error('Failed to fetch setup status:', error);
        setLoading(false);
      }
    };

    fetchStatus();
    pollInterval = setInterval(fetchStatus, 2000);

    return () => clearInterval(pollInterval);
  }, [machineId, onComplete, onError]);

  if (loading && !status) {
    return (
      <div className="p-8 text-center">
        <div className="inline-block">
          <div className="animate-spin h-10 w-10 border-2 border-neon-cyan border-t-transparent rounded-full mb-4"></div>
          <p className="font-mono text-neon-cyan">
            > INITIALIZING_SETUP_MONITOR...
          </p>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="p-8 text-center">
        <p className="font-mono text-neon-pink">
          > ERROR_LOADING_SETUP_STATUS
        </p>
      </div>
    );
  }

  const stageInfo = STAGE_LABELS[status.stage] || STAGE_LABELS.initializing;
  const isComplete = status.stage === 'complete';
  const isFailed = status.stage === 'failed';

  const copyPin = () => {
    if (status.sunshinePin) {
      navigator.clipboard.writeText(status.sunshinePin).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Status Header */}
      <div className={`p-6 rounded-lg border-2 ${
        isFailed ? 'border-neon-pink/50 bg-pink-950/20' :
        isComplete ? 'border-neon-lime/50 bg-green-950/20' :
        'border-neon-cyan/50 bg-cyan-950/20'
      }`}>
        <div className="flex items-center gap-3 mb-4">
          <span className="text-2xl">{stageInfo.emoji}</span>
          <div>
            <h3 className={`font-bold font-mono ${
              isFailed ? 'text-neon-pink' :
              isComplete ? 'text-neon-lime' :
              'text-neon-cyan'
            }`}>
              {stageInfo.label}
            </h3>
            <p className="text-sm font-mono text-gray-400">
              {status.message}
            </p>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-slate-800/50 rounded-full h-2 overflow-hidden border border-neon-cyan/30">
          <div
            className={`h-full transition-all duration-300 ${
              isFailed ? 'bg-neon-pink' :
              isComplete ? 'bg-neon-lime' :
              'bg-neon-cyan'
            }`}
            style={{ width: `${Math.min(status.progress, 100)}%` }}
          />
        </div>

        <div className="flex justify-between items-center mt-3">
          <span className="text-xs font-mono text-gray-400">
            {status.progress}% Complete
          </span>
          <span className="text-xs font-mono text-gray-400">
            Updated {Math.round((Date.now() - new Date(status.updatedAt).getTime()) / 1000)}s ago
          </span>
        </div>
      </div>

      {/* Sunshine PIN - shown when setup is complete */}
      {isComplete && status.sunshinePin && (
        <div className="p-6 rounded-lg border-2 border-neon-lime/50 bg-green-950/20 space-y-4">
          <div>
            <p className="text-xs font-mono text-gray-400 mb-2">SUNSHINE_PIN</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-neon-lime text-lg font-bold tracking-wider bg-slate-900/50 p-3 rounded border border-neon-lime/30">
                {status.sunshinePin}
              </code>
              <button
                onClick={copyPin}
                className={`px-4 py-2 rounded font-mono text-sm font-bold whitespace-nowrap transition-all ${
                  copied
                    ? 'bg-neon-lime text-slate-900'
                    : 'border-2 border-neon-lime text-neon-lime hover:bg-neon-lime/10'
                }`}
              >
                {copied ? '✓ COPIED' : 'COPY'}
              </button>
            </div>
            <p className="text-xs font-mono text-neon-lime/70 mt-2">
              ℹ Use this PIN to pair with Sunshine from your client device
            </p>
          </div>
        </div>
      )}

      {/* Sunshine URL - shown when setup is complete */}
      {isComplete && status.sunshineUrl && (
        <div className="p-6 rounded-lg border-2 border-neon-cyan/50 bg-cyan-950/20">
          <p className="text-xs font-mono text-gray-400 mb-2">SUNSHINE_WEB_UI</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-neon-cyan text-sm break-all bg-slate-900/50 p-3 rounded border border-neon-cyan/30">
              {status.sunshineUrl}
            </code>
            <button
              onClick={() => window.open(status.sunshineUrl, '_blank')}
              className="px-4 py-2 rounded font-mono text-sm font-bold bg-neon-cyan text-slate-900 hover:bg-cyan-300 transition-all whitespace-nowrap"
            >
              OPEN
            </button>
          </div>
        </div>
      )}

      {/* Error Message */}
      {isFailed && status.error && (
        <div className="p-6 rounded-lg border-2 border-neon-pink/50 bg-pink-950/20">
          <p className="text-xs font-mono text-gray-400 mb-2">ERROR</p>
          <p className="font-mono text-neon-pink text-sm">
            {status.error}
          </p>
        </div>
      )}

      {/* Stage Timeline */}
      <div className="space-y-2">
        <p className="text-xs font-mono text-gray-400 mb-3">SETUP_STAGES</p>
        <div className="space-y-1">
          {Object.entries(STAGE_LABELS).slice(0, 8).map(([stageKey, { label, emoji }]) => {
            const stages = [
              'initializing',
              'waiting_for_instance',
              'installing_drivers',
              'installing_cloudypad',
              'configuring_sunshine',
              'installing_clients',
              'starting_service',
              'complete',
            ];
            const stageIndex = stages.indexOf(stageKey);
            const currentIndex = stages.indexOf(status.stage);
            const isDone = stageIndex < currentIndex;
            const isCurrent = stageIndex === currentIndex;

            return (
              <div
                key={stageKey}
                className={`flex items-center gap-2 p-2 rounded text-xs font-mono ${
                  isCurrent
                    ? 'bg-cyan-950/30 border-l-2 border-neon-cyan'
                    : isDone
                    ? 'text-neon-lime/70'
                    : 'text-gray-500'
                }`}
              >
                <span className="w-6">
                  {isDone ? '✓' : isCurrent ? '⟳' : '○'}
                </span>
                <span>{emoji}</span>
                <span className="flex-1">{label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
