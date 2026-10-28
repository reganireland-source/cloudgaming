/**
 * components/PurposePicker.tsx — "What is this machine for?" at the top of the launch form.
 *
 * A purpose (backend: src/providers/shared/purposes.ts) sets the machine size
 * requirements, a disk size and the software add-ons in one go. Everything it
 * sets stays editable below. "Custom" leaves the form exactly as it was.
 */
'use client';

export interface PurposeToggle { id: string; label: string; help?: string; default: boolean; addons: string[] }
export interface Purpose {
  id: string; name: string; blurb: string;
  size: { minVcpus?: number; minMemoryGb?: number; devTier?: boolean };
  diskGb: number; addons: string[]; toggles: PurposeToggle[]; quality?: string;
}
export type Intensity = 'light' | 'standard' | 'heavy';
const INTENSITY: Array<{ id: Intensity; label: string; hint: string }> = [
  { id: 'light', label: 'Light', hint: 'cheapest size that fits' },
  { id: 'standard', label: 'Standard', hint: 'a middle size' },
  { id: 'heavy', label: 'Heavy', hint: 'most capable size here' },
];

export function PurposePicker({ purposes, purposeId, onPurpose, intensity, onIntensity, toggles, onToggle }: {
  purposes: Purpose[]; purposeId: string; onPurpose: (id: string) => void;
  intensity: Intensity; onIntensity: (i: Intensity) => void;
  toggles: Record<string, boolean>; onToggle: (id: string, on: boolean) => void;
}) {
  const p = purposes.find((x) => x.id === purposeId);
  return (
    <div>
      <p className="label mb-2">What is this machine for?</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {purposes.map((x) => (
          <button key={x.id} type="button" onClick={() => onPurpose(x.id)} aria-pressed={purposeId === x.id}
            className={`rounded border px-3 py-2 text-left text-xs transition ${purposeId === x.id ? 'border-neon-cyan text-slate-100 bg-neon-cyan/[0.06]' : 'border-white/10 text-slate-400 hover:border-white/30'}`}>
            <span className="block font-semibold">{x.name}</span>
          </button>
        ))}
        <button type="button" onClick={() => onPurpose('')} aria-pressed={purposeId === ''}
          className={`rounded border px-3 py-2 text-left text-xs transition ${purposeId === '' ? 'border-neon-cyan text-slate-100 bg-neon-cyan/[0.06]' : 'border-white/10 text-slate-400 hover:border-white/30'}`}>
          <span className="block font-semibold">Custom</span>
          <span className="block mt-0.5 text-slate-500">choose everything yourself</span>
        </button>
      </div>
      {p && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-slate-400">{p.blurb}</p>
          <div>
            <p className="text-xs text-slate-500 mb-1">Size</p>
            <div className="flex flex-wrap gap-2">
              {INTENSITY.map((i) => (
                <button key={i.id} type="button" onClick={() => onIntensity(i.id)} aria-pressed={intensity === i.id} title={i.hint}
                  className={`text-xs px-3 py-1 rounded border ${intensity === i.id ? 'border-neon-cyan text-neon-cyan' : 'border-white/15 text-slate-300 hover:border-white/30'}`}>{i.label}</button>
              ))}
              <span className="text-xs text-slate-500 self-center">{INTENSITY.find((i) => i.id === intensity)?.hint}</span>
            </div>
          </div>
          {p.toggles.length > 0 && (
            <div className="grid sm:grid-cols-2 gap-1">
              {p.toggles.map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input type="checkbox" checked={!!toggles[t.id]} onChange={(e) => onToggle(t.id, e.target.checked)} /> {t.label}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
