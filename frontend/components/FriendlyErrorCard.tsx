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

import type { FriendlyError } from '@/lib/auth';

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
