'use client';

/**
 * ============================================================================
 * frontend/components/FriendlyErrorCard.tsx — A PLAIN-ENGLISH ERROR, WITH THE FIX
 * ============================================================================
 *
 * Whenever a cloud action fails, the backend translates the cloud's cryptic
 * error into a "friendly error" (backend: src/providers/errors.ts):
 *   title        "Your project isn't allowed any GPUs yet"
 *   explanation  what it means
 *   fixes        numbered steps
 *   consoleUrl   a button straight to the right cloud console page
 *   raw          the cloud's original words (hidden behind "Show details")
 * This card displays one. It's used by the operation console, the launch
 * form and the Config page, so errors look the same everywhere.
 *
 * Also accepts a simpler { message, tip } pair for non-cloud errors.
 * ============================================================================
 */

import Link from 'next/link';
import type { FriendlyError } from '@/lib/auth';

/**
 * One plain sentence on WHOSE problem this is, shown above everything else,
 * so a quota limit on your cloud account is never mistaken for a bug.
 */
const CAUSE: Record<string, { label: string; text: string; link?: { href: string; label: string } }> = {
  quota: { label: 'Quota', text: 'A GPU limit on your cloud account in this region — not a problem with the app. Raise it with the cloud, or use a region where you already have quota.', link: { href: '/regions', label: 'See your regions & quotas' } },
  region: { label: 'Region', text: 'This region isn’t switched on or offered for your cloud account — not a problem with the app.', link: { href: '/regions', label: 'See which regions you can use' } },
  permission: { label: 'Permissions', text: 'The key you saved isn’t allowed to do this in your cloud account. Give it the missing role/policy (steps below).', link: { href: '/settings', label: 'Open Config' } },
  capacity: { label: 'Out of stock', text: 'The cloud has no spare machines of this type here right now. Temporary — nothing is wrong with your account or the app.' },
  credentials: { label: 'Keys', text: 'The saved cloud key is wrong, expired or was deleted.', link: { href: '/settings', label: 'Update keys on Config' } },
  account: { label: 'Account', text: 'Your cloud account’s billing or subscription is blocking this.' },
};

export default function FriendlyErrorCard({
  friendly,
  message,
  tip,
  compact = false,
}: {
  friendly?: FriendlyError | null;
  message?: string;
  tip?: string;
  compact?: boolean;
}) {
  const title = friendly?.title || message || 'Something went wrong';
  return (
    <div role="alert" className="rounded-md border border-neon-pink/40 bg-[#2a1017]/60 p-4 text-sm">
      <p className="font-semibold text-neon-pink flex items-start gap-2">
        <span aria-hidden>✗</span>
        <span>{title}</span>
      </p>
      {friendly?.cause && CAUSE[friendly.cause] && (
        <p className="mt-2 rounded border border-white/15 bg-black/30 px-2.5 py-1.5 text-xs text-slate-200 leading-relaxed">
          <span className="mr-1.5 rounded bg-neon-amber/15 border border-neon-amber/50 px-1 uppercase tracking-label text-[0.62rem] text-neon-amber">Cause: {CAUSE[friendly.cause].label}</span>
          {CAUSE[friendly.cause].text}
          {CAUSE[friendly.cause].link && <> <Link href={CAUSE[friendly.cause].link!.href} className="text-neon-cyan hover:underline whitespace-nowrap">{CAUSE[friendly.cause].link!.label} →</Link></>}
        </p>
      )}
      {friendly?.explanation && <p className="mt-2 text-slate-300 leading-relaxed">{friendly.explanation}</p>}

      {/* Numbered fix steps, or the single tip for simple errors. */}
      {friendly?.fixes?.length ? (
        <div className="mt-3">
          <p className="label mb-1.5">How to fix it</p>
          <ol className="list-decimal pl-5 space-y-1 text-slate-200 leading-relaxed">
            {friendly.fixes.map((fix, i) => (
              <li key={i}>{fix}</li>
            ))}
          </ol>
        </div>
      ) : tip ? (
        <p className="mt-2 text-slate-300">
          <span className="text-neon-amber">Tip:</span> {tip}
        </p>
      ) : null}

      {friendly?.consoleUrl && (
        <a
          href={friendly.consoleUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-neon mt-3 text-xs"
        >
          {friendly.consoleLabel || 'Open the cloud console'} ↗
        </a>
      )}

      {/* The cloud's exact words, for reference (or to search for). */}
      {!compact && friendly?.raw && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">Show the original error</summary>
          <pre className="mt-2 whitespace-pre-wrap break-all text-[0.7rem] text-slate-400 font-mono bg-black/30 rounded p-2 max-h-40 overflow-auto">
            {friendly.raw}
          </pre>
        </details>
      )}
    </div>
  );
}
