/**
 * components/AddonPicker.tsx — "Extra tools" on the launch form.
 *
 * Generic, optional add-ons installed on the new machine after it is playable
 * (catalog comes from the API: backend src/providers/shared/addons.ts).
 * Nothing is ticked by default, so a plain gaming machine stays lean.
 */
'use client';

import { useMemo, useState } from 'react';

export interface AddonOption { key: string; label: string; default: string; help?: string }
export interface AddonInfo {
  id: string; name: string; description: string; diskGb: number;
  requires: string[]; options: AddonOption[]; experimental?: boolean;
}
export interface AddonCatalog { addons: AddonInfo[]; bundles: Array<{ id: string; name: string; addons: string[] }> }
export type AddonChoice = Record<string, Record<string, string>>; // id -> option overrides

/** Selection → request body, dropping anything left at its default. */
export function addonsBody(chosen: AddonChoice) {
  return Object.entries(chosen).map(([id, options]) => {
    const o = Object.fromEntries(Object.entries(options).filter(([, v]) => v.trim() !== ''));
    return Object.keys(o).length ? { id, options: o } : { id };
  });
}

export function AddonPicker({ catalog, chosen, onChange }: { catalog: AddonCatalog; chosen: AddonChoice; onChange: (c: AddonChoice) => void }) {
  const [open, setOpen] = useState(false);
  const byId = useMemo(() => new Map(catalog.addons.map((a) => [a.id, a])), [catalog]);

  // Everything that will be installed: the ticked ones plus what they need.
  const needed = useMemo(() => {
    const out = new Map<string, string>(); // id -> reason ('' = ticked)
    const visit = (id: string, because: string) => {
      const a = byId.get(id);
      if (!a || out.has(id)) return;
      out.set(id, because);
      a.requires.forEach((r) => visit(r, `needed by ${a.name}`));
    };
    Object.keys(chosen).forEach((id) => visit(id, ''));
    return out;
  }, [chosen, byId]);
  const extraDisk = [...needed.keys()].reduce((n, id) => n + (byId.get(id)?.diskGb || 0), 0);

  const toggle = (id: string) => {
    const next = { ...chosen };
    if (id in next) delete next[id]; else next[id] = {};
    onChange(next);
  };
  const setOpt = (id: string, key: string, value: string) => onChange({ ...chosen, [id]: { ...chosen[id], [key]: value } });
  const applyBundle = (ids: string[]) => {
    const next = { ...chosen };
    ids.forEach((id) => { if (!(id in next)) next[id] = {}; });
    onChange(next);
  };

  const count = Object.keys(chosen).length;
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="label block mb-2 text-left w-full hover:text-slate-200">
        {open ? '▾' : '▸'} Extra tools (optional){count > 0 && <span className="text-neon-lime"> · {count} chosen</span>}
      </button>
      {!open && <p className="text-xs text-slate-500">Developer and build tools to install on this machine. Skip it for a plain gaming PC.</p>}
      {open && (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            Installed in the background after the machine is playable (progress: /var/log/cg-addons.log on the machine). Nothing here is activated or signed in for you.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">Quick picks:</span>
            {catalog.bundles.map((b) => (
              <button key={b.id} type="button" onClick={() => applyBundle(b.addons)}
                className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:border-neon-cyan hover:text-neon-cyan">{b.name}</button>
            ))}
            {count > 0 && <button type="button" onClick={() => onChange({})} className="text-xs text-slate-400 hover:text-slate-200 px-1">Clear</button>}
          </div>
          <ul className="space-y-2">
            {catalog.addons.map((a) => {
              const why = needed.get(a.id);
              const ticked = a.id in chosen;
              return (
                <li key={a.id} className="rounded border border-white/10 p-2">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" className="mt-1" checked={ticked || why !== undefined} disabled={!ticked && why !== undefined}
                      onChange={() => toggle(a.id)} />
                    <span className="text-sm">
                      <span className="text-slate-100">{a.name}</span>
                      <span className="text-slate-500 text-xs"> · ≈{a.diskGb} GB</span>
                      {a.experimental && <span className="text-neon-amber text-xs"> · experimental</span>}
                      {!ticked && why && <span className="text-slate-500 text-xs"> · {why}</span>}
                      <span className="block text-xs text-slate-400">{a.description}</span>
                    </span>
                  </label>
                  {ticked && a.options.length > 0 && (
                    <div className="mt-2 ml-6 grid sm:grid-cols-2 gap-2">
                      {a.options.map((o) => (
                        <label key={o.key} className="text-xs text-slate-400">
                          {o.label}
                          <input value={chosen[a.id]?.[o.key] ?? ''} placeholder={o.default} maxLength={200}
                            onChange={(e) => setOpt(a.id, o.key, e.target.value)}
                            className="input-neon w-full px-2 py-1 mt-1 font-mono text-xs" autoComplete="off" />
                          {o.help && <span className="block text-slate-500">{o.help}</span>}
                        </label>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {extraDisk > 0 && <p className="text-xs text-neon-amber">These add about {Math.ceil(extraDisk)} GB: make sure the disk size above has room for them as well as your games.</p>}
        </div>
      )}
    </div>
  );
}
