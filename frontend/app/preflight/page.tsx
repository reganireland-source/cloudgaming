'use client';

/**
 * ============================================================================
 * app/preflight/page.tsx — PRE-FLIGHT CHECK BEFORE YOUR FIRST LAUNCH
 * ============================================================================
 *
 * One page that says whether the whole setup is ready, and exactly where to
 * fix anything that isn't:
 *   - this website (Vercel): is NEXT_PUBLIC_API_URL right, can it reach the
 *     backend, do the location helpers work?
 *   - the backend (Railway): GET /api/status/preflight — variables, database
 *     and migrations, encryption, your saved keys, Google/Apple sign-in
 *     callback URLs, CORS, live price feeds (src/services/PreflightService.ts)
 * Nothing here shows a secret value.
 * ============================================================================
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { API_BASE_URL, apiUrl } from '@/lib/api';
import { getToken } from '@/lib/auth';

type Status = 'pass' | 'warn' | 'fail' | 'running';
interface Check {
  group: string; id: string; label: string; status: Status; message: string; tip?: string; copy?: string[];
  vars?: Array<{ name: string; set: boolean; value: string; where: string; example?: string }>;
}

const ICON: Record<Status, { mark: string; className: string; word: string }> = {
  pass: { mark: '✓', className: 'text-neon-lime', word: 'OK' },
  warn: { mark: '!', className: 'text-neon-amber', word: 'Optional' },
  fail: { mark: '✗', className: 'text-neon-pink', word: 'Fix' },
  running: { mark: '…', className: 'text-slate-400', word: 'Checking' },
};
const GROUP_LABEL: Record<string, string> = {
  website: 'Website (Vercel)', server: 'Backend (Railway)', database: 'Database', encryption: 'Encryption & your keys',
  'sign-in': 'Sign-in providers', browser: 'Website ↔ API', prices: 'Live prices',
};

async function websiteChecks(): Promise<{ checks: Check[]; backend: any | null }> {
  const checks: Check[] = [];
  const isLocal = typeof window !== 'undefined' && window.location.hostname === 'localhost';
  // 1. NEXT_PUBLIC_API_URL
  const problems: string[] = [];
  if (!process.env.NEXT_PUBLIC_API_URL) problems.push('not set (falling back to localhost)');
  if (!/\/api$/.test(API_BASE_URL)) problems.push('should end with /api');
  if (!isLocal && !/^https:\/\//.test(API_BASE_URL)) problems.push('should start with https://');
  checks.push({ group: 'website', id: 'api-url', label: 'Backend address (NEXT_PUBLIC_API_URL)', status: problems.length ? 'fail' : 'pass',
    message: problems.length ? `${API_BASE_URL} — ${problems.join(', ')}.` : API_BASE_URL,
    tip: problems.length ? 'Vercel → your project → Settings → Environment Variables: NEXT_PUBLIC_API_URL = https://<app>.up.railway.app/api, then Redeploy (it is baked in at build time).' : undefined });

  // 2. Backend reachable + its own checklist
  let backend: any = null;
  const t0 = performance.now();
  try {
    const token = getToken();
    const res = await fetch(apiUrl('/status/preflight'), { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
    backend = await res.json();
    checks.push({ group: 'website', id: 'reach', label: 'Website can reach the backend', status: res.ok ? 'pass' : 'fail',
      message: res.ok ? `Yes (${Math.round(performance.now() - t0)} ms).` : `Backend answered HTTP ${res.status}.` });
  } catch {
    checks.push({ group: 'website', id: 'reach', label: 'Website can reach the backend', status: 'fail',
      message: 'No answer — the backend is down, the address is wrong, or CORS blocked it.',
      tip: 'Open the backend address + /status in a new tab. If that loads, set FRONTEND_URL on Railway to this site’s address (no trailing slash).' });
  }

  // 3. Location helpers (Vercel-only features)
  try {
    const geo = await fetch('/api/geo', { cache: 'no-store' }).then((r) => r.json());
    checks.push({ group: 'website', id: 'geo', label: '“Your location” from your connection', status: geo.available ? 'pass' : 'warn',
      message: geo.available ? `Works (${[geo.city, geo.country].filter(Boolean).join(', ') || 'located'}).` : 'Not available here (only works on Vercel) — typing a city still works.' });
  } catch {
    checks.push({ group: 'website', id: 'geo', label: '“Your location” from your connection', status: 'warn', message: 'Couldn’t check.' });
  }
  try {
    const g = await fetch('/api/geocode?q=Ballarat', { cache: 'no-store' }).then((r) => r.json());
    checks.push({ group: 'website', id: 'geocode', label: 'City search (any town worldwide)', status: g.source === 'open-meteo' ? 'pass' : 'warn',
      message: g.source === 'open-meteo' ? 'Works.' : 'The worldwide geocoder isn’t reachable — only the built-in list of big cities and countries works.' });
  } catch {
    checks.push({ group: 'website', id: 'geocode', label: 'City search', status: 'warn', message: 'Couldn’t check.' });
  }
  return { checks, backend };
}

export default function PreflightPage() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [summary, setSummary] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setSignedIn(!!getToken());
    const { checks: site, backend } = await websiteChecks();
    const all = [...site, ...((backend?.checks as Check[]) || [])];
    setChecks(all);
    const fails = all.filter((c) => c.status === 'fail').length;
    const warns = all.filter((c) => c.status === 'warn').length;
    setSummary(fails ? `${fails} problem${fails === 1 ? '' : 's'} to fix before launching` : warns ? `Ready for launch — ${warns} optional item${warns === 1 ? '' : 's'}` : 'All clear — ready for launch');
    setRunning(false);
  }, []);

  useEffect(() => { run(); }, [run]);

  const fails = checks?.filter((c) => c.status === 'fail').length || 0;
  const groups = checks ? [...new Set(checks.map((c) => c.group))] : [];

  return (
    <div className="space-y-4 sm:space-y-6 max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold neon-text mb-1 font-mono">[ PRE_FLIGHT ]</h1>
          <p className="text-sm text-slate-400">Checks the website, backend, database, encryption and sign-in setup before you launch anything. No secrets are shown.</p>
        </div>
        <button type="button" onClick={run} disabled={running} className="btn-neon text-xs disabled:opacity-50">{running ? 'Checking…' : '↻ Run again'}</button>
      </div>

      {checks && (
        <div className={`rounded-lg border px-3 py-2.5 text-sm ${fails ? 'border-neon-pink/50 bg-neon-pink/[0.05] text-neon-pink' : 'border-neon-lime/50 bg-neon-lime/[0.05] text-neon-lime'}`}>
          {fails ? '✗ ' : '✓ '}{summary}
          {!signedIn && <span className="block text-xs text-slate-400 mt-0.5"><Link href="/login?next=/preflight" className="text-neon-cyan hover:underline">Sign in</Link> to also check that your saved cloud keys still decrypt.</span>}
          {signedIn && <span className="block text-xs text-slate-400 mt-0.5">GPU quota and which regions are switched on, per cloud: see <Link href="/regions" className="text-neon-cyan hover:underline">Regions</Link>.</span>}
        </div>
      )}

      {!checks ? <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; RUNNING_CHECKS…</p> : groups.map((g) => (
        <section key={g} className="space-y-1.5">
          <h2 className="text-xs tracking-label uppercase text-slate-500">{GROUP_LABEL[g] || g}</h2>
          <ul className="space-y-1.5">
            {checks.filter((c) => c.group === g).map((c) => (
              <li key={c.id} className={`rounded border px-3 py-2 ${c.status === 'fail' ? 'border-neon-pink/40' : 'border-white/10'}`}>
                <div className="flex items-start gap-2">
                  <span className={`shrink-0 w-4 text-center font-bold ${ICON[c.status].className}`} aria-label={ICON[c.status].word}>{ICON[c.status].mark}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-100">{c.label}</p>
                    <p className="text-xs text-slate-400 break-words">{c.message}</p>
                    {c.tip && <p className="text-xs text-neon-amber mt-1">→ {c.tip}</p>}
                    {c.copy?.map((v) => <CopyLine key={v} value={v} />)}
                    {c.vars && (
                      <dl className="mt-2 space-y-2 border-t border-white/10 pt-2">
                        {c.vars.map((v) => (
                          <div key={v.name} className="text-xs">
                            <dt className="flex items-center gap-2">
                              <span className={v.set ? 'text-neon-lime' : 'text-neon-amber'} aria-label={v.set ? 'set' : 'not set'}>{v.set ? '✓' : '○'}</span>
                              <code className="text-slate-100">{v.name}</code>
                              <span className="text-[0.66rem] text-slate-500">{v.set ? 'set' : 'not set'}</span>
                            </dt>
                            <dd className="pl-5 text-slate-300">= {v.value}</dd>
                            <dd className="pl-5 text-slate-500">From: {v.where}</dd>
                            {v.example && <dd className="pl-5 text-slate-500 break-all">Looks like: <span className="text-slate-400">{v.example}</span></dd>}
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function CopyLine({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="mt-1 flex items-center gap-2 min-w-0">
      <code className="min-w-0 flex-1 truncate rounded bg-black/40 px-2 py-1 text-[0.7rem] text-slate-200">{value}</code>
      <button type="button" className="text-[0.7rem] text-neon-cyan hover:underline shrink-0"
        onClick={() => navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => undefined)}>
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
