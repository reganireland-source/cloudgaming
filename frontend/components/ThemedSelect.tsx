'use client';

/**
 * components/ThemedSelect.tsx — a drop-down in the app's own style
 *
 * Replaces the browser's native <select> menu (which on macOS/Windows is
 * drawn by the OS in light colours) with a listbox that matches the neon
 * theme: grouped options, a tick on the chosen one, optional second line.
 * Keyboard: ↑/↓ move, Enter/Space picks, Esc/Tab closes, typing a letter
 * jumps to the next option starting with it. Closes on an outside click.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface ThemedOption { value: string; label: string; hint?: string; group?: string; disabled?: boolean }

export default function ThemedSelect({ value, options, onChange, ariaLabel, className = '', align = 'left' }: {
  value: string;
  options: ThemedOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  className?: string;
  /** Which edge the (possibly wider) menu lines up with. */
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Open upwards when there's more room above; cap the height to the room there is.
  const [place, setPlace] = useState<{ up: boolean; max: number }>({ up: false, max: 320 });
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const enabled = useMemo(() => options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0), [options]);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => {
    if (open && active >= 0) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const openList = () => {
    const r = root.current?.getBoundingClientRect();
    if (r) {
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const up = below < 240 && above > below;
      setPlace({ up, max: Math.max(160, Math.min(320, up ? above : below)) });
    }
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const pick = (i: number) => { const o = options[i]; if (o && !o.disabled) { onChange(o.value); setOpen(false); } };
  const move = (dir: 1 | -1) => {
    const pos = enabled.indexOf(active);
    setActive(enabled[Math.min(enabled.length - 1, Math.max(0, pos + dir))] ?? enabled[0]);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openList(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false);
    else if (e.key.length === 1) {
      const k = e.key.toLowerCase();
      const after = enabled.filter((i) => i > active).concat(enabled.filter((i) => i <= active));
      const hit = after.find((i) => options[i].label.toLowerCase().startsWith(k));
      if (hit !== undefined) setActive(hit);
    }
  };

  let lastGroup: string | undefined;
  return (
    <div ref={root} className={`relative ${className}`}>
      <button type="button" onClick={() => (open ? setOpen(false) : openList())} onKeyDown={onKey}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} aria-label={ariaLabel}
        className={`input-neon w-full px-2 py-1.5 flex items-center justify-between gap-2 text-left ${open ? 'border-neon-cyan/70' : ''}`}>
        <span className="truncate">{current?.label ?? '—'}</span>
        <span aria-hidden className={`text-neon-cyan/70 text-[0.6rem] transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>
      {open && (
        <ul ref={list} id={`${id}-list`} role="listbox" aria-label={ariaLabel} tabIndex={-1}
          style={{ maxHeight: place.max }}
          className={`absolute z-50 ${place.up ? 'bottom-full mb-1' : 'top-full mt-1'} left-0 right-0 ${align === 'right' ? 'sm:left-auto' : 'sm:right-auto'} sm:min-w-full sm:w-max sm:max-w-[min(34rem,90vw)] overflow-auto rounded-md border border-neon-cyan/30 bg-cyber-darker shadow-[0_12px_40px_-8px_rgba(0,0,0,0.8),0_0_0_1px_rgba(95,215,224,0.08)] py-1`}>
          {options.map((o, i) => {
            const header = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            const selected = o.value === value;
            return (
              <li key={o.value} role="presentation">
                {header && <p className="px-3 pt-2 pb-1 text-[0.6rem] uppercase tracking-label text-slate-500">{header}</p>}
                <div role="option" aria-selected={selected} aria-disabled={o.disabled || undefined} data-i={i}
                  onMouseEnter={() => !o.disabled && setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}
                  className={`flex items-start gap-2 px-3 py-1.5 text-xs cursor-pointer ${o.disabled ? 'opacity-40 cursor-not-allowed' : ''} ${i === active ? 'bg-neon-cyan/10 text-slate-100' : 'text-slate-300'}`}>
                  <span aria-hidden className={`w-3 shrink-0 ${selected ? 'text-neon-cyan' : 'opacity-0'}`}>✓</span>
                  <span className="min-w-0">
                    <span className={selected ? 'text-neon-cyan' : ''}>{o.label}</span>
                    {o.hint && <span className="block text-[0.66rem] text-slate-500">{o.hint}</span>}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
