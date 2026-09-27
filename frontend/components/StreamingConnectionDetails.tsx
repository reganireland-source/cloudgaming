'use client';

import { useState, useEffect } from 'react';
import { apiUrl } from '@/lib/api';

interface StreamingConnectionDetailsProps {
  machineId: string;
  clientType: 'sunshine' | 'moonlight';
  onBack: () => void;
  onClose: () => void;
}

interface ConnectionDetails {
  protocol: string;
  sunshineWebUrl?: string;
  moonlightConnectionString?: string;
  ipAddress: string;
  port: number;
  connectionInstructions: string;
}

export default function StreamingConnectionDetails({
  machineId,
  clientType,
  onBack,
  onClose,
}: StreamingConnectionDetailsProps) {
  const [details, setDetails] = useState<ConnectionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const fetchDetails = async () => {
      try {
        const response = await fetch(apiUrl(`/streaming/${machineId}`));
        const data = await response.json();
        setDetails(data);
      } catch (error) {
        console.error('Failed to fetch streaming details:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchDetails();
  }, [machineId]);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  if (loading) {
    return (
      <div className="p-12 text-center">
        <div className="inline-block">
          <div className="animate-spin h-8 w-8 border border-neon-cyan/30 border-t-transparent rounded-full mb-4"></div>
          <p className="font-mono text-neon-cyan text-sm">
            {'> FETCHING_CONNECTION_DETAILS...'}
          </p>
        </div>
      </div>
    );
  }

  if (!details) {
    return (
      <div className="p-12 text-center">
        <p className="font-mono text-neon-pink mb-6">
          {'> ERROR_LOADING_DETAILS'}
        </p>
        <button
          onClick={onBack}
          className="px-4 py-2 rounded font-mono border border-neon-cyan/30 text-neon-cyan hover:border-neon-cyan/80 transition-all"
        >
          [ BACK ]
        </button>
      </div>
    );
  }

  const isSunshine = clientType === 'sunshine';
  const bgColor = isSunshine ? 'cyan-950/20' : 'magenta-950/20';
  const borderColor = isSunshine ? 'border-neon-cyan' : 'border-neon-magenta';
  const textColor = isSunshine ? 'text-neon-cyan' : 'text-neon-magenta';
  const accentColor = isSunshine ? 'text-neon-lime' : 'text-neon-pink';

  return (
    <div className="flex flex-col h-full">
      <div className={`border-b ${borderColor}/30 p-6`}>
        <h3 className={`text-xl font-bold font-mono neon-text mb-2 ${textColor}`}>
          {isSunshine ? '[ SUNSHINE_CONNECTION ]' : '[ MOONLIGHT_CONNECTION ]'}
        </h3>
        <p className={`${accentColor} text-sm font-mono`}>
          {(isSunshine ? '> browser_streaming_via_webrtc' : '> native_client_streaming').toUpperCase()}
        </p>
      </div>

      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        {isSunshine ? (
          <>
            {/* Sunshine Web UI Details */}
            <div className={`p-4 rounded border ${borderColor}/30 bg-${bgColor}`}>
              <p className="text-xs font-mono text-gray-400 mb-2">WEB_UI_URL</p>
              <div className="flex items-center gap-2">
                <code className={`flex-1 font-mono ${textColor} text-sm font-bold break-all`}>
                  {details.sunshineWebUrl}
                </code>
                <button
                  onClick={() => copyToClipboard(details.sunshineWebUrl || '', 'sunshine-url')}
                  className={`px-3 py-1 rounded text-xs font-bold whitespace-nowrap transition-all ${
                    copied === 'sunshine-url'
                      ? 'bg-neon-lime text-slate-900'
                      : `border ${borderColor}/50 ${textColor} hover:border-neon-cyan`
                  }`}
                >
                  {copied === 'sunshine-url' ? '✓ COPIED' : 'COPY'}
                </button>
              </div>
            </div>

            <div className={`p-4 rounded border ${borderColor}/30 bg-${bgColor}`}>
              <button
                onClick={() => window.open(details.sunshineWebUrl, '_blank')}
                className="w-full px-4 py-3 rounded font-mono font-bold bg-neon-cyan text-slate-900 hover:bg-cyan-300 transition-all"
              >
                [ OPEN_IN_BROWSER ]
              </button>
            </div>

            <div className={`p-4 rounded border ${borderColor}/30 bg-${bgColor}`}>
              <p className="text-xs font-mono text-gray-400 mb-3">QUICK_START</p>
              <ol className="text-sm font-mono space-y-2 text-gray-300">
                <li>1. Click "OPEN_IN_BROWSER" button above</li>
                <li>2. Log in with your Sunshine credentials</li>
                <li>3. Select a game and click Play</li>
                <li>4. Start gaming with hardware acceleration</li>
              </ol>
              <p className={`text-xs font-mono mt-3 p-2 rounded bg-blue-950/20 border-l-2 border-blue-500 ${accentColor}`}>
                ⓘ Sunshine uses JavaScript WebRTC codec in browser. For best performance, use a modern browser (Chrome, Firefox, Edge).
              </p>
            </div>
          </>
        ) : (
          <>
            {/* Moonlight Client Details */}
            <div>
              <p className={`text-xs font-mono text-gray-400 mb-2`}>HOST_IP</p>
              <div className="flex items-center gap-2 mb-4">
                <code className={`flex-1 font-mono ${textColor} text-sm font-bold`}>
                  {details.ipAddress}
                </code>
                <button
                  onClick={() => copyToClipboard(details.ipAddress, 'host-ip')}
                  className={`px-3 py-1 rounded text-xs font-bold whitespace-nowrap transition-all ${
                    copied === 'host-ip'
                      ? 'bg-neon-pink text-slate-900'
                      : `border ${borderColor}/50 ${textColor} hover:border-neon-magenta`
                  }`}
                >
                  {copied === 'host-ip' ? '✓ COPIED' : 'COPY'}
                </button>
              </div>
            </div>

            <div>
              <p className={`text-xs font-mono text-gray-400 mb-2`}>PORT</p>
              <div className="flex items-center gap-2">
                <code className={`flex-1 font-mono ${textColor} text-sm font-bold`}>
                  {details.port}
                </code>
                <button
                  onClick={() => copyToClipboard(details.port.toString(), 'port')}
                  className={`px-3 py-1 rounded text-xs font-bold whitespace-nowrap transition-all ${
                    copied === 'port'
                      ? 'bg-neon-pink text-slate-900'
                      : `border ${borderColor}/50 ${textColor} hover:border-neon-magenta`
                  }`}
                >
                  {copied === 'port' ? '✓ COPIED' : 'COPY'}
                </button>
              </div>
            </div>

            <div className={`p-4 rounded border ${borderColor}/30 bg-${bgColor}`}>
              <p className="text-xs font-mono text-gray-400 mb-3">SETUP_STEPS</p>
              <ol className="text-sm font-mono space-y-3 text-gray-300">
                <li>1. Download Moonlight from: <a href="https://github.com/ReplayCoding/moonlight-qt/releases" target="_blank" className={`${accentColor} underline hover:no-underline`}>github.com/ReplayCoding/moonlight-qt</a></li>
                <li>2. Install and launch Moonlight on your device</li>
                <li>3. Add host: <code className={textColor}>{details.ipAddress}:{details.port}</code></li>
                <li>4. Complete pairing flow (PIN will be displayed)</li>
                <li>5. Select game from Moonlight library</li>
                <li>6. Click Play and start streaming</li>
              </ol>
            </div>

            <div className={`p-3 rounded border-l-2 ${borderColor} bg-${bgColor}`}>
              <p className={`text-xs font-mono ${accentColor}`}>
                ✓ Ultra-low latency (optimal for competitive gaming)
              </p>
              <p className={`text-xs font-mono ${accentColor}`}>
                ✓ Hardware-accelerated video decoding
              </p>
            </div>
          </>
        )}
      </div>

      <div className={`border-t ${borderColor}/30 p-6 flex justify-between gap-3`}>
        <button
          onClick={onBack}
          className={`px-4 py-2 rounded font-mono border ${borderColor}/50 ${textColor} hover:${borderColor} transition-all`}
        >
          [ BACK ]
        </button>
        <button
          onClick={onClose}
          className="px-6 py-2 rounded font-mono font-bold bg-neon-lime text-slate-900 hover:bg-lime-300 transition-all"
        >
          [ DONE ]
        </button>
      </div>
    </div>
  );
}
