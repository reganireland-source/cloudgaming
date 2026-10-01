'use client';

/**
 * components/BillsAndAccess.tsx — BILLS (what you owe, and when) + BILLING ACCESS
 *
 * Each connected cloud's recent invoices (GET /api/costs/invoices) with due
 * dates where the cloud provides them, and — per cloud — how to switch on the
 * read access the app needs for actual costs and invoices, as ready-to-paste
 * Cloud Shell commands filled in with this account's ids
 * (GET /api/costs/billing-access).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch, type FriendlyError } from '@/lib/auth';
import CloudLogo from '@/components/CloudLogo';

interface Invoice { id: string; period?: string; issued?: string; due?: string; amount: number | null; currency: string; balance?: number | null; status?: string }
interface CloudInvoices {
  provider: string; label: string; status: 'ok' | 'needs-setup' | 'error' | 'not-connected';
  invoices?: Invoice[]; notes?: string[]; consoleUrl?: string; consoleLabel?: string; error?: FriendlyError; checkedAt?: string;
}
interface Access {
  provider: string; label: string; connected: boolean; shell: { name: string; url: string }; summary: string;
  steps: string[]; cli: string; consoleUrl: string; consoleLabel: string; notes?: string[];
}

const money = (n: number | null | undefined, cur: string) =>
  n == null ? '—' : `${cur ? cur + ' ' : ''}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDay = (d?: string) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const daysUntil = (d?: string) => (d ? Math.round((Date.parse(d + 'T00:00:00Z') - Date.now()) / 86400000) : null);
const unpaid = (i: Invoice) => (i.balance != null ? i.balance > 0.004 : !/paid|billed|in progress/i.test(i.status || ''));

export default function BillsAndAccess() {
  const [bills, setBills] = useState<CloudInvoices[] | null>(null);
  const [access, setAccess] = useState<Access[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try {
      const [b, a] = await Promise.all([
        apiFetch<{ clouds: CloudInvoices[] }>(`/costs/invoices${refresh ? '?refresh=true' : ''}`),
        apiFetch<{ clouds: Access[] }>('/costs/billing-access'),
      ]);
      setBills(b.clouds); setAccess(a.clouds);
    } catch { setBills([]); } finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // The next bill to pay, across clouds.
  const next = (bills || []).flatMap((c) => (c.invoices || []).filter((i) => i.due && unpaid(i)).map((i) => ({ ...i, cloud: c.label })))
    .sort((a, b) => String(a.due).localeCompare(String(b.due)))[0];

  return (
    <section className="neon-card rounded-lg p-3 sm:p-5 border border-neon-cyan/30 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm tracking-label font-bold neon-text font-mono">[ BILLS &amp; BILLING_ACCESS ]</h2>
          <p className="text-xs text-slate-400 mt-1 max-w-3xl">Your actual invoices from each cloud — amount, due date and what&apos;s still to pay where the cloud reports it — and, per cloud, the one-time commands that give the app read access to costs and invoices.</p>
        </div>
        <button type="button" onClick={() => load(true)} disabled={busy} className="btn-neon text-xs disabled:opacity-40">{busy ? 'Checking…' : '↻ Re-check'}</button>
      </div>

      {next && (
        <p className="text-sm text-slate-200">
          Next bill: <span className="text-neon-amber font-semibold tabular-nums">{money(next.balance ?? next.amount, next.currency)}</span> to {next.cloud},
          due <span className="text-slate-100">{fmtDay(next.due)}</span>
          {(() => { const d = daysUntil(next.due); return d == null ? null : <span className={d < 0 ? 'text-neon-pink' : 'text-slate-400'}> ({d < 0 ? `${-d} days overdue` : d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`})</span>; })()}
        </p>
      )}

      {!bills ? <p className="font-mono text-xs text-neon-cyan animate-pulse">&gt; ASKING_THE_CLOUDS…</p> : (
        <div className="grid lg:grid-cols-2 gap-3">
          {bills.map((c) => <CloudBills key={c.provider} c={c} access={access.find((a) => a.provider === c.provider)} />)}
        </div>
      )}
    </section>
  );
}

function CloudBills({ c, access }: { c: CloudInvoices; access?: Access }) {
  const needsSetup = c.status === 'needs-setup' || c.status === 'error';
  const [open, setOpen] = useState(needsSetup);
  useEffect(() => { if (needsSetup) setOpen(true); }, [needsSetup]);
  if (c.status === 'not-connected') {
    return (
      <div className="rounded border border-white/10 p-3 text-xs text-slate-400 flex items-center gap-2">
        <CloudLogo provider={c.provider} size={18} /> <span className="text-slate-300">{c.label}</span> — no keys. <Link href="/settings" className="text-neon-cyan hover:underline">Add them on Config</Link>
      </div>
    );
  }
  return (
    <div className="rounded border border-white/10 p-3 space-y-2 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm text-slate-100"><CloudLogo provider={c.provider} size={18} /> {c.label}</span>
        <span className={`text-[0.66rem] uppercase tracking-label border rounded px-1.5 py-0.5 ${c.status === 'ok' ? 'text-neon-lime border-neon-lime/50' : 'text-neon-amber border-neon-amber/50'}`}>
          {c.status === 'ok' ? 'invoices ✓' : c.status === 'needs-setup' ? 'needs access' : 'couldn’t read'}
        </span>
      </div>

      {c.status === 'ok' && (c.invoices?.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead><tr className="text-[0.66rem] uppercase tracking-label text-slate-500 text-left">
              <th className="font-normal pb-1 pr-2">Period</th><th className="font-normal pb-1 pr-2">Issued</th><th className="font-normal pb-1 pr-2">Due</th>
              <th className="font-normal pb-1 pr-2 text-right">Amount</th><th className="font-normal pb-1 pr-2 text-right">To pay</th><th className="font-normal pb-1">Status</th>
            </tr></thead>
            <tbody>
              {c.invoices.slice(0, 6).map((i) => {
                const d = daysUntil(i.due);
                const owed = unpaid(i) && i.due;
                return (
                  <tr key={i.id} className="border-t border-white/5">
                    <td className="py-1 pr-2 text-slate-200 whitespace-nowrap">{i.period || '—'}</td>
                    <td className="py-1 pr-2 text-slate-400 whitespace-nowrap">{fmtDay(i.issued)}</td>
                    <td className={`py-1 pr-2 whitespace-nowrap ${owed ? (d != null && d < 0 ? 'text-neon-pink' : 'text-neon-amber') : 'text-slate-400'}`}>{fmtDay(i.due)}</td>
                    <td className="py-1 pr-2 text-right text-slate-200 whitespace-nowrap">{money(i.amount, i.currency)}</td>
                    <td className="py-1 pr-2 text-right whitespace-nowrap">{i.balance == null ? <span className="text-slate-500">—</span> : money(i.balance, i.currency)}</td>
                    <td className="py-1 text-slate-400">{i.status || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="text-xs text-slate-400">No invoices in the last 6 months.</p>)}

      {needsSetup && c.error && <p className="text-xs text-neon-amber">! {c.error.title}{c.error.explanation ? ` — ${c.error.explanation}` : ''}</p>}
      {c.notes?.map((n, i) => <p key={i} className="text-[0.7rem] text-slate-500">{n}</p>)}
      {c.consoleUrl && <a href={c.consoleUrl} target="_blank" rel="noreferrer" className="inline-block text-xs text-neon-cyan hover:underline">{c.consoleLabel || 'Open the console'} ↗</a>}

      {access && (
        <div className="pt-1">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="text-xs text-slate-300 hover:text-neon-cyan">
            {open ? '▾' : '▸'} Billing access setup <span className="text-slate-500">— costs + invoices, one-time</span>
          </button>
          {open && (
            <div className="mt-2 space-y-2 text-xs">
              <p className="text-slate-400">{access.summary}</p>
              <ol className="list-decimal pl-4 space-y-1 text-slate-300">{access.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              <p className="text-slate-400">Run in <a href={access.shell.url} target="_blank" rel="noreferrer" className="text-neon-cyan hover:underline">{access.shell.name} ↗</a> — one complete command per line, already filled in for your account:</p>
              <Commands text={access.cli} />
              {access.notes?.map((n, i) => <p key={i} className="text-[0.7rem] text-slate-500">{n}</p>)}
              <a href={access.consoleUrl} target="_blank" rel="noreferrer" className="inline-block text-neon-cyan hover:underline">{access.consoleLabel} ↗</a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Commands({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded bg-black/40 border border-white/10 p-2 pr-14 text-[0.7rem] text-slate-300 whitespace-pre-wrap break-all"><code className="!bg-transparent !border-0 !p-0">{text}</code></pre>
      <button type="button" className="absolute top-1 right-1 text-[0.66rem] text-neon-cyan border border-neon-cyan/40 rounded px-1.5 py-0.5 bg-cyber-darker"
        onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined)}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
