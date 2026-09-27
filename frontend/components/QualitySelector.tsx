'use client';

import { useState } from 'react';
import { apiUrl } from '@/lib/api';

interface QualityOption {
  value: string;
  label: string;
  description: string;
  resolution: string;
  fps: number;
  bitrate: string;
  dataPerHour: string;
  costNote: string;
}

const QUALITY_OPTIONS: QualityOption[] = [
  {
    value: 'budget',
    label: 'Budget',
    description: 'Entry-level streaming for light gaming',
    resolution: '1280×720',
    fps: 30,
    bitrate: '5 Mbps',
    dataPerHour: '2.25 GB/hr',
    costNote: 'Lowest bandwidth & egress cost',
  },
  {
    value: 'good',
    label: 'Good',
    description: 'Balanced quality and performance',
    resolution: '1920×1080',
    fps: 60,
    bitrate: '12 Mbps',
    dataPerHour: '5.4 GB/hr',
    costNote: 'Good balance of quality and cost',
  },
  {
    value: 'high',
    label: 'High',
    description: 'Premium quality for competitive gaming',
    resolution: '2560×1440',
    fps: 60,
    bitrate: '25 Mbps',
    dataPerHour: '11.25 GB/hr',
    costNote: 'Higher bandwidth, recommended default',
  },
  {
    value: 'ultra',
    label: 'Ultra',
    description: '4K ultra-high definition streaming',
    resolution: '3840×2160',
    fps: 60,
    bitrate: '50 Mbps',
    dataPerHour: '22.5 GB/hr',
    costNote: 'Maximum quality, highest cost',
  },
];

interface QualitySelectorProps {
  selectedQuality?: string;
  onChange?: (quality: string) => void;
  onConfirm?: (quality: string) => void;
  isLoading?: boolean;
  machineId?: string; // If provided, will update existing machine
  mode?: 'inline' | 'modal'; // Display mode
}

export default function QualitySelector({
  selectedQuality = 'high',
  onChange,
  onConfirm,
  isLoading = false,
  machineId,
  mode = 'inline',
}: QualitySelectorProps) {
  const [selected, setSelected] = useState(selectedQuality);
  const [updating, setUpdating] = useState(false);

  const handleSelect = (quality: string) => {
    setSelected(quality);
    if (onChange) {
      onChange(quality);
    }
  };

  const handleConfirm = async () => {
    if (machineId && mode === 'modal') {
      setUpdating(true);
      try {
        const response = await fetch(apiUrl(`/machines/${machineId}/quality`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quality: selected }),
        });

        if (response.ok) {
          if (onConfirm) {
            onConfirm(selected);
          }
        }
      } catch (error) {
        console.error('Failed to update quality:', error);
      } finally {
        setUpdating(false);
      }
    } else if (onConfirm) {
      onConfirm(selected);
    }
  };

  if (mode === 'modal') {
    return (
      <div className="space-y-6">
        <div className="mb-6">
          <h3 className="font-bold font-mono text-neon-cyan mb-2 text-sm">
            [ STREAMING_QUALITY ]
          </h3>
          <p className="font-mono text-sm text-gray-400">
            Select a quality preset based on your connection and preferences
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {QUALITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => handleSelect(option.value)}
              className={`p-4 rounded-lg border transition-all text-left ${
                selected === option.value
                  ? 'border-neon-cyan bg-cyan-950/30'
                  : 'border-neon-cyan/30 bg-slate-800/50 hover:border-neon-cyan/60'
              }`}
              disabled={isLoading || updating}
            >
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h4 className="font-bold font-mono text-neon-cyan">
                    {option.label}
                  </h4>
                  <p className="text-xs text-gray-400">{option.description}</p>
                </div>
                <div
                  className={`w-5 h-5 rounded border flex items-center justify-center ${
                    selected === option.value
                      ? 'border-neon-cyan bg-neon-cyan'
                      : 'border-neon-cyan/30'
                  }`}
                >
                  {selected === option.value && (
                    <div className="w-2 h-2 bg-slate-900" />
                  )}
                </div>
              </div>

              <div className="text-xs font-mono space-y-1 text-gray-300 mt-2">
                <div className="flex justify-between">
                  <span>Resolution:</span>
                  <span className="text-neon-lime">{option.resolution}</span>
                </div>
                <div className="flex justify-between">
                  <span>FPS:</span>
                  <span className="text-neon-magenta">{option.fps}</span>
                </div>
                <div className="flex justify-between">
                  <span>Bitrate:</span>
                  <span className="text-neon-pink">{option.bitrate}</span>
                </div>
                <div className="flex justify-between">
                  <span>Data/Hour:</span>
                  <span className="text-neon-cyan">{option.dataPerHour}</span>
                </div>
                <div className="pt-2 border-t border-neon-cyan/20">
                  <p className="text-neon-lime italic">{option.costNote}</p>
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="p-4 rounded-lg border border-neon-cyan/30 bg-slate-900/50 text-xs font-mono space-y-2">
          <p className="text-gray-400">
            ℹ Higher quality increases bandwidth usage and data egress costs
          </p>
          <p className="text-gray-400">
            ℹ For high latency connections, consider lower quality presets
          </p>
          <p className="text-neon-lime">
            💡 Recommended: "{
              QUALITY_OPTIONS.find((q) => q.value === 'high')?.label
            }" for most users
          </p>
        </div>

        {machineId && (
          <button
            onClick={handleConfirm}
            disabled={updating || isLoading}
            className="w-full px-6 py-3 rounded font-mono font-bold bg-neon-cyan text-slate-900 hover:bg-cyan-300 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {updating ? '> UPDATING_QUALITY...' : '[ UPDATE_QUALITY ]'}
          </button>
        )}
      </div>
    );
  }

  // Inline mode - compact display
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-mono text-gray-400 mb-3">
          STREAMING_QUALITY
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {QUALITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => handleSelect(option.value)}
              className={`p-3 rounded border transition-all text-center font-mono text-xs font-bold ${
                selected === option.value
                  ? 'border-neon-cyan bg-cyan-950/30 text-neon-cyan'
                  : 'border-neon-cyan/30 text-gray-400 hover:border-neon-cyan/60'
              }`}
              disabled={isLoading}
            >
              {option.label.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Show selected quality details */}
      {QUALITY_OPTIONS.find((q) => q.value === selected) && (
        <div className="p-3 rounded bg-cyan-950/20 border border-neon-cyan/30 text-xs font-mono">
          <p className="text-gray-400">
            {
              QUALITY_OPTIONS.find((q) => q.value === selected)
                ?.dataPerHour
            }{' '}
            •{' '}
            {
              QUALITY_OPTIONS.find((q) => q.value === selected)
                ?.resolution
            }{' '}
            @ {QUALITY_OPTIONS.find((q) => q.value === selected)?.fps}fps
          </p>
        </div>
      )}
    </div>
  );
}
