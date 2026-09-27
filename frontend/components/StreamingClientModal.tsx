'use client';

import { useState } from 'react';
import StreamingConnectionDetails from './StreamingConnectionDetails';

interface StreamingClientModalProps {
  machineId: string;
  machineIp: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function StreamingClientModal({
  machineId,
  machineIp,
  isOpen,
  onClose,
}: StreamingClientModalProps) {
  const [selectedClient, setSelectedClient] = useState<'sunshine' | 'moonlight'>('sunshine');
  const [showDetails, setShowDetails] = useState(false);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border-2 border-neon-cyan rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {!showDetails ? (
          <>
            <div className="border-b-2 border-neon-cyan/30 p-6">
              <h2 className="text-2xl font-bold font-mono neon-text mb-2">
                [ SELECT_STREAMING_CLIENT ]
              </h2>
              <p className="text-neon-lime text-sm font-mono">
                {`> machine: ${machineId} | ip: ${machineIp}`.toUpperCase()}
              </p>
            </div>

            <div className="p-6 space-y-4">
              {/* Sunshine Web UI */}
              <button
                onClick={() => setSelectedClient('sunshine')}
                className={`w-full p-6 rounded-lg border-2 transition-all text-left ${
                  selectedClient === 'sunshine'
                    ? 'border-neon-cyan bg-cyan-950/30'
                    : 'border-neon-cyan/30 bg-slate-800/50 hover:border-neon-cyan/60'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-bold font-mono text-neon-cyan text-lg mb-2">
                      [ SUNSHINE_WEB_UI ]
                    </h3>
                    <p className="text-neon-lime text-sm font-mono mb-3">
                      Browser-based streaming via WebRTC
                    </p>
                    <ul className="text-xs font-mono text-neon-lime/80 space-y-1">
                      <li>✓ No installation required</li>
                      <li>✓ Works on any browser</li>
                      <li>✓ Instant access</li>
                      <li>⚠ Slightly higher latency than Moonlight</li>
                    </ul>
                  </div>
                  <div className={`w-6 h-6 rounded border-2 flex items-center justify-center ${
                    selectedClient === 'sunshine'
                      ? 'border-neon-cyan bg-neon-cyan'
                      : 'border-neon-cyan/30'
                  }`}>
                    {selectedClient === 'sunshine' && (
                      <div className="w-3 h-3 bg-slate-900" />
                    )}
                  </div>
                </div>
              </button>

              {/* Moonlight */}
              <button
                onClick={() => setSelectedClient('moonlight')}
                className={`w-full p-6 rounded-lg border-2 transition-all text-left ${
                  selectedClient === 'moonlight'
                    ? 'border-neon-magenta bg-magenta-950/30'
                    : 'border-neon-magenta/30 bg-slate-800/50 hover:border-neon-magenta/60'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-bold font-mono text-neon-magenta text-lg mb-2">
                      [ MOONLIGHT_CLIENT ]
                    </h3>
                    <p className="text-neon-pink text-sm font-mono mb-3">
                      Native app with hardware acceleration
                    </p>
                    <ul className="text-xs font-mono text-neon-pink/80 space-y-1">
                      <li>✓ Ultra-low latency</li>
                      <li>✓ Hardware-accelerated decode</li>
                      <li>✓ Best performance</li>
                      <li>⚠ Requires client installation</li>
                    </ul>
                  </div>
                  <div className={`w-6 h-6 rounded border-2 flex items-center justify-center ${
                    selectedClient === 'moonlight'
                      ? 'border-neon-magenta bg-neon-magenta'
                      : 'border-neon-magenta/30'
                  }`}>
                    {selectedClient === 'moonlight' && (
                      <div className="w-3 h-3 bg-slate-900" />
                    )}
                  </div>
                </div>
              </button>
            </div>

            <div className="border-t-2 border-neon-cyan/30 p-6 flex justify-end gap-3">
              <button
                onClick={onClose}
                className="px-6 py-2 rounded font-mono border border-neon-cyan/50 text-neon-cyan hover:border-neon-cyan transition-all"
              >
                [ CANCEL ]
              </button>
              <button
                onClick={() => setShowDetails(true)}
                className="px-6 py-2 rounded font-mono font-bold bg-neon-cyan text-slate-900 hover:bg-cyan-300 transition-all"
              >
                [ CONNECT ]
              </button>
            </div>
          </>
        ) : (
          <StreamingConnectionDetails
            machineId={machineId}
            clientType={selectedClient}
            onBack={() => setShowDetails(false)}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
