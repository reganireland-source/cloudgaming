'use client';
// ↑ Client component: it reads the URL's #fragment, which only the browser can see.

/**
 * ============================================================================
 * frontend/app/auth/callback/page.tsx — LANDING SPOT AFTER GOOGLE / APPLE
 * ============================================================================
 *                                               (URL: /auth/callback)
 * THE ROUND TRIP
 * --------------
 *   1. /login: you click "Continue with Google" → browser goes to the backend
 *   2. backend → Google's sign-in screen → back to the backend
 *   3. backend → HERE, with the result in the URL's "#fragment":
 *        success:  /auth/callback#token=abc123&next=/machines
 *        failure:  /auth/callback#error=Something%20broke&tip=Try...&code=...
 *
 * WHY THE "#" PART?
 * -----------------
 * Everything after "#" stays in the browser — it is never sent to any
 * server (not even Vercel's logs), which makes it a safer place to carry
 * the token than "?token=". We read it, save the token, then wipe the "#…"
 * off the address bar with history.replaceState so it isn't left lying
 * around in history or copied into a shared link.
 *
 * Suspense-safe: this page doesn't use useSearchParams at all (it reads
 * window.location.hash inside useEffect, which only runs in the browser),
 * so Next.js can pre-build it without a Suspense boundary.
 * ============================================================================
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { safeNextPath, setToken } from '@/lib/auth';
import { useAuth } from '@/components/AuthProvider';

type Status =
  | { kind: 'working'; step: string }
  | { kind: 'error'; message: string; tip?: string; code?: string };

export default function AuthCallbackPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [status, setStatus] = useState<Status>({ kind: 'working', step: 'READING_SIGN_IN_RESULT' });

  // In development React runs effects twice on purpose (to catch bugs). The
  // hash is wiped after the first run, so a second run would wrongly see "no
  // token". This ref remembers that we've already handled it.
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    // "#token=abc&next=/x" → drop the "#" and parse like a query string.
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = params.get('token');
    const next = safeNextPath(params.get('next'));
    const error = params.get('error');

    // Remove the fragment from the address bar (and from history) right away.
    window.history.replaceState(null, '', window.location.pathname);

    if (error || !token) {
      setStatus({
        kind: 'error',
        message: error || 'The sign-in result was missing.',
        tip:
          params.get('tip') ||
          (error ? undefined : 'Please start again from the sign-in page.'),
        code: params.get('code') || undefined,
      });
      return;
    }

    setToken(token);
    setStatus({ kind: 'working', step: 'LOADING_ACCOUNT' });

    // Tell AuthProvider there's a new token and load the user.
    refresh().then((user) => {
      if (user) {
        setStatus({ kind: 'working', step: 'SIGNED_IN — REDIRECTING' });
        router.replace(next);
      } else {
        setStatus({
          kind: 'error',
          message: "We couldn't load your account after signing in.",
          tip: "The sign-in link may have expired, or the backend may be unreachable — check the BACKEND light and try again.",
        });
      }
    });
  }, [refresh, router]);

  return (
    <div className="flex justify-center py-4 sm:py-10">
      <div className="w-full max-w-[420px]">
        <p className="label mb-3 text-center">[ AUTH_CALLBACK ]</p>
        <div className="neon-card rounded-md p-5 sm:p-6">
          {status.kind === 'working' ? (
            <p className="font-mono text-[0.8rem] tracking-label text-neon-cyan/90" role="status" aria-live="polite">
              &gt; {status.step}…
            </p>
          ) : (
            <div role="alert" className="space-y-4">
              <div className="rounded border border-neon-pink/40 bg-neon-pink/[0.06] px-3 py-2.5 text-[0.78rem]">
                <p className="font-semibold text-neon-pink">{status.message}</p>
                {status.tip && <p className="mt-1 text-slate-300">{status.tip}</p>}
                {status.code && (
                  <p className="mt-2 text-[0.68rem] uppercase tracking-label text-slate-500">
                    Code: {status.code}
                  </p>
                )}
              </div>
              <Link href="/login" className="btn-neon w-full py-2">
                ← Back to sign in
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
