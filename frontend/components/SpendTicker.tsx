'use client';

/**
 * ============================================================================
 * components/SpendTicker.tsx — SPEND AT A GLANCE, ON EVERY PAGE
 * ============================================================================
 *
 * Sits in the status strip (SystemStatusBar) while signed in:
 *   TODAY USD 1.20 · WTD USD 8.40 · MTD USD 52.10 · → USD 116/mo
 * From GET /api/costs/summary, every minute. Each figure uses what the clouds
 * actually billed where they've reported it, and the app's estimate for the
 * rest (clouds report 8–24 h late) — "≈" marks a figure with estimates in it.
 * Weeks start Monday; days are UTC, like the clouds' bills. Click → Costs page.
 * Narrow screens show fewer figures (MTD always).
 * ============================================================================
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/auth';
import { usd } from '@/lib/money';
import { useAuth } from './AuthProvider';

interface Part { usd: number; billedUsd: number }
interface Summary {
  currency: 'USD';
  today: Part;
  weekToDate: Part & { since: string };
  monthToDate: Part & { since: string };
  projectedMonthUsd: number;
}

const POLL_MS = 60_000;
// "≈" when any of it is still the app's estimate rather than the bill.
const approx = (p: Part) => (p.billedUsd < p.usd - 0.005 ? '≈' : '');
const whole = (n: number) => usd(n, n >= 100 ? 0 : 2);

// Figures appear as the screen widens: MTD always, then WTD, then Today and Proj.
function Item({ label, value, show = 'inline-flex', title }: { label: string; value: string; show?: string; title: string }) {
  return (
    <span className={`${show} items-baseline gap-1 whitespace-nowrap`} title={title}>
      <span className="text-[0.62rem] tracking-label uppercase text-slate-500">{label}</span>
      <span className="text-[0.68rem] text-slate-300 tabular-nums">{value}</span>
    </span>
  );
}

export default function SpendTicker() {
  const { user } = useAuth();
  const [s, setS] = useState<Summary | null>(null);

  useEffect(() => {
    if (!user) { setS(null); return; }
    let cancelled = false;
    const load = () => apiFetch<Summary>('/costs/summary').then((r) => { if (!cancelled) setS(r); }).catch(() => {});
    load();
    const t = setInterval(load, POLL_MS);
    const onFocus = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onFocus);
    return () => { cancelled = true; clearInterval(t); document.removeEventListener('visibilitychange', onFocus); };
  }, [user]);

  if (!user || !s) return null;
  const billedNote = (p: Part) => (p.billedUsd > 0 ? ` — USD ${p.billedUsd.toFixed(2)} of it as billed by your clouds, the rest estimated` : ' — estimated (no billed days reported yet)');
  return (
    <Link href="/costs" className="flex items-center gap-2 sm:gap-3 min-w-0 rounded px-1 -mx-1 hover:bg-white/[0.04]" aria-label="Spend summary — open Costs">
      <Item show="hidden xl:inline-flex" label="Today" value={approx(s.today) + usd(s.today.usd)} title={`Today so far (UTC)${billedNote(s.today)}`} />
      <Item show="hidden md:inline-flex" label="WTD" value={approx(s.weekToDate) + usd(s.weekToDate.usd)} title={`Week to date, since Monday ${s.weekToDate.since} (UTC)${billedNote(s.weekToDate)}`} />
      <Item label="MTD" value={approx(s.monthToDate) + usd(s.monthToDate.usd)} title={`Month to date, since ${s.monthToDate.since}${billedNote(s.monthToDate)}`} />
      <Item show="hidden xl:inline-flex" label="Proj." value={`≈${whole(s.projectedMonthUsd)}/mo`} title="Projected for the whole month at this month's daily rate" />
    </Link>
  );
}
