'use client';

/**
 * components/MegaQuotaCommand.tsx — ONE PASTE FOR ALL THE QUOTA YOU NEED
 *
 * Per cloud: every quota request the region check says is still missing,
 * across every region the cloud sells our GPUs in, for the tiers and modes
 * you tick — as one block to paste into that cloud's shell (Cloud Shell /
 * AWS CloudShell / Azure Cloud Shell). Built from the same per-quota
 * commands the region details show, so it skips quotas you already have
 * and requests already waiting, and (Google) updates a request that exists
 * instead of failing on "already exists". Duplicates (the project-wide
 * Google cap, Azure's extension install) appear once.
 */

import { useMemo, useState } from 'react';
import { RUN_MODES, type AccessReport, type RegionAccess, type RunMode } from '@/lib/regionAccess';
import { fillCommand, type CommandContext } from '@/lib/commandContext';

const TIERS = [
  { id: 'Good', label: 'Good' }, { id: 'Better', label: 'Better' }, { id: 'Best', label: 'Best' }, { id: 'Super', label: 'Super' },
];
const SHELL: Record<string, { name: string; href: string }> = {
  gcp: { name: 'Google Cloud Shell', href: 'https://shell.cloud.google.com/' },
  aws: { name: 'AWS CloudShell', href: 'https://console.aws.amazon.com/cloudshell/home' },
  azure: { name: 'Azure Cloud Shell (Bash)', href: 'https://shell.azure.com/' },
};
const SCOPES = [5, 10, 20, 0]; // nearest N regions; 0 = all

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
}

export default function MegaQuotaCommand({ report, ctx, me }: { report: AccessReport; ctx: CommandContext; me: { lat: number; lng: number } | null }) {
  const clouds = report.clouds.filter((c) => c.connected && !c.error);
  const [provider, setProvider] = useState(clouds[0]?.provider || 'gcp');
  const [tiers, setTiers] = useState<string[]>(TIERS.map((t) => t.id));
  const [modes, setModes] = useState<RunMode[]>(['normal', 'spot', 'big', 'bigSpot']);
  const [scope, setScope] = useState(0);
  const [optIn, setOptIn] = useState(false); // AWS: also switch on opt-in regions
  const [copied, setCopied] = useState(false);
  const cloud = clouds.find((c) => c.provider === provider);

  const built = useMemo(() => {
    if (!cloud) return null;
    const modeLabels = RUN_MODES.filter((m) => modes.includes(m.id)).map((m) => m.label);
    const wanted = (unlock: string) => {
      const [tier, ...rest] = unlock.split(' · ');
      return tiers.includes(tier) && modeLabels.includes(rest.join(' · '));
    };
    let regions: RegionAccess[] = cloud.regions.filter((r) => r.status !== 'not-offered' && r.status !== 'not-connected');
    if (me) regions = [...regions].sort((a, b) => km(me, a) - km(me, b));
    if (scope) regions = regions.slice(0, scope);

    const seen = new Set<string>();
    const out: string[] = [];
    let commands = 0, waiting = 0, have = 0, skippedOff = 0, unknown = 0;
    const add = (line: string) => {
      if (!line.trim() || seen.has(line)) return false;
      seen.add(line); out.push(line);
      if (!line.startsWith('#')) commands++;
      return true;
    };
    for (const r of regions) {
      const block: string[] = [];
      if (r.status === 'not-enabled') {
        if (provider === 'aws' && optIn) {
          // A new region starts at the default (0) quota: switch it on, then ask for 8 vCPUs of each.
          block.push(`aws account enable-region --region-name ${r.region}`,
            `aws service-quotas request-service-quota-increase --region ${r.region} --service-code ec2 --quota-code L-DB2E81BA --desired-value 8`,
            `aws service-quotas request-service-quota-increase --region ${r.region} --service-code ec2 --quota-code L-3819A6DF --desired-value 8`);
        } else { skippedOff++; continue; }
      } else if (r.status === 'unknown' || !r.quotaDetail) { unknown++; continue; }
      for (const q of r.quotaDetail || []) {
        if (!q.unlocks.some(wanted)) continue;
        if (q.pending?.length) { waiting++; continue; }
        if (!q.request?.cli) { have++; continue; }
        block.push(...fillCommand(q.request.cli, ctx, provider).split('\n'));
      }
      const fresh = block.filter((l) => l.trim() && !seen.has(l));
      if (fresh.length) {
        add(`# ${r.name} (${r.region})`);
        fresh.forEach(add);
      }
    }
    return { text: out.join('\n'), commands, waiting, have, skippedOff, unknown, regions: regions.length };
  }, [cloud, provider, tiers, modes, scope, optIn, ctx, me]);

  if (!clouds.length) return null;
  const toggle = <T,>(list: T[], v: T, set: (x: T[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const shell = SHELL[provider];
  const header = built && built.commands
    ? `# Mega bulk quota request — ${cloud?.label}: ${built.commands} command${built.commands === 1 ? '' : 's'}. Paste into ${shell?.name || 'the cloud shell'}.\n` +
      `# Each line runs on its own; one that fails (e.g. a quota that can't be raised) doesn't stop the rest.\n`
    : '';
  const text = built ? header + built.text : '';

  return (
    <details className="rounded-lg border border-neon-amber/30 bg-neon-amber/[0.03] px-3 py-2">
      <summary className="cursor-pointer text-sm text-slate-200">
        <span className="text-neon-amber font-semibold">Mega bulk quota command</span>
        <span className="text-slate-500 text-xs"> — every missing quota, all regions, one paste per cloud</span>
      </summary>
      <div className="mt-3 space-y-3 text-xs text-slate-300">
        <div role="tablist" aria-label="Cloud" className="inline-flex rounded border border-white/10 overflow-hidden">
          {clouds.map((c) => (
            <button key={c.provider} type="button" role="tab" aria-selected={provider === c.provider} onClick={() => setProvider(c.provider)}
              className={`px-3 py-1 border-l first:border-l-0 border-white/10 ${provider === c.provider ? 'bg-neon-amber/10 text-neon-amber' : 'text-slate-400 hover:text-slate-200'}`}>
              {c.label}
            </button>
          ))}
        </div>

        {provider === 'oracle' ? (
          <p className="text-slate-400">Oracle has no command for limit increases: they’re support requests. In the Oracle console, Help (?) → Request service limit increase, and list every region at once in one request.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              <fieldset className="flex flex-wrap items-center gap-2">
                <legend className="sr-only">Tiers</legend>
                <span className="text-[0.7rem] uppercase tracking-label text-slate-500">Tiers</span>
                {TIERS.map((t) => (
                  <label key={t.id} className="inline-flex items-center gap-1 cursor-pointer">
                    <input type="checkbox" checked={tiers.includes(t.id)} onChange={() => toggle(tiers, t.id, setTiers)} />{t.label}
                  </label>
                ))}
              </fieldset>
              <fieldset className="flex flex-wrap items-center gap-2">
                <legend className="sr-only">Modes</legend>
                <span className="text-[0.7rem] uppercase tracking-label text-slate-500">Modes</span>
                {RUN_MODES.map((m) => (
                  <label key={m.id} className="inline-flex items-center gap-1 cursor-pointer">
                    <input type="checkbox" checked={modes.includes(m.id)} onChange={() => toggle(modes, m.id, setModes)} />{m.label}
                  </label>
                ))}
              </fieldset>
              <label className="inline-flex items-center gap-2">
                <span className="text-[0.7rem] uppercase tracking-label text-slate-500">Regions</span>
                <select value={scope} onChange={(e) => setScope(Number(e.target.value))} className="bg-cyber-darker border border-white/15 rounded px-1.5 py-0.5">
                  {SCOPES.map((n) => <option key={n} value={n}>{n ? `${me ? 'nearest' : 'first'} ${n}` : 'all'}</option>)}
                </select>
              </label>
              {provider === 'aws' && (
                <label className="inline-flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />Also switch on opt-in regions
                </label>
              )}
            </div>

            {built && (
              <p className="text-slate-400 tabular-nums">
                {built.regions} region{built.regions === 1 ? '' : 's'} ·{' '}
                <span className="text-neon-amber">{built.commands} request{built.commands === 1 ? '' : 's'} to make</span>
                {built.waiting ? <> · <span className="text-neon-cyan">{built.waiting} already waiting</span></> : null}
                {built.skippedOff ? <> · {built.skippedOff} switched-off region{built.skippedOff === 1 ? '' : 's'} left out</> : null}
                {built.unknown ? <> · {built.unknown} couldn’t be checked (left out)</> : null}
              </p>
            )}

            {built && built.commands ? (
              <div className="relative">
                <pre className="max-h-80 overflow-auto rounded bg-black/40 border border-white/10 p-2 pr-16 text-[0.7rem] text-slate-300 whitespace-pre"><code className="!bg-transparent !border-0 !p-0">{text}</code></pre>
                <button type="button" className="absolute top-1 right-3 text-[0.66rem] text-neon-cyan border border-neon-cyan/40 rounded px-1.5 py-0.5 bg-cyber-darker"
                  onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined)}>
                  {copied ? 'Copied' : 'Copy all'}
                </button>
              </div>
            ) : (
              <p className="text-neon-lime">✓ Nothing to request for this selection{built?.waiting ? ' — the rest is already waiting on the cloud' : ''}.</p>
            )}

            <p className="text-slate-500">
              Paste into <a href={shell?.href} target="_blank" rel="noreferrer" className="text-neon-cyan hover:underline">{shell?.name} ↗</a>.
              {provider === 'gcp' && ' Google may question many requests at once; the project-wide "GPUs (all regions)" cap still limits how many machines run together.'}
              {provider === 'aws' && ' AWS counts quota in vCPUs per region; 8 covers any one machine, including the Super g6e.2xlarge.'}
              {' '}Then press ↻ Re-check here to see them as ⏳ waiting.
            </p>
          </>
        )}
      </div>
    </details>
  );
}
