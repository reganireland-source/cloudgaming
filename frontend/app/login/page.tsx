'use client';
// ↑ Client component: forms, typing, live validation and redirects all
//   happen in the browser.

/**
 * ============================================================================
 * frontend/app/login/page.tsx — SIGN IN / CREATE ACCOUNT   (URL: /login)
 * ============================================================================
 *
 * WHAT THE VISITOR SEES
 * ---------------------
 *   ┌─────────────────────────────────┐
 *   │  [ Sign in ] [ Create account ] │  ← tabs (?mode=signup opens the 2nd)
 *   │  (G) Continue with Google       │  ← only if the server has them set up
 *   │  ( ) Continue with Apple        │
 *   │  ───────────── or ───────────── │
 *   │  Email / Password (+ name,      │
 *   │  confirm & a live checklist     │
 *   │  when creating an account)      │
 *   │  [ Sign in ]                    │
 *   └─────────────────────────────────┘
 *
 * HOW SIGN-IN WORKS
 * -----------------
 * Email + password: we POST to /api/auth/login (or /register), get back
 * `{ token, user }`, save the token (lib/auth.ts), tell AuthProvider to
 * refresh, then go to ?next= (or /machines).
 *
 * Google / Apple: the button is a plain link that sends the WHOLE browser to
 * the backend's /auth/oauth/<provider>/start. Google/Apple then send you back
 * to the backend, which sends you to /auth/callback#token=… (see
 * app/auth/callback/page.tsx). It can't be a fetch() because Google's sign-in
 * screen has to be a real page the user sees.
 *
 * WHY <Suspense>?
 * ---------------
 * useSearchParams() (which reads ?mode= and ?next=) only exists in the
 * browser. Next.js pre-builds pages as static HTML at build time, and it
 * requires components that read search params to sit inside a <Suspense>
 * boundary so it can build the rest of the page and fill that part in later.
 * Without it, `npm run build` fails.
 * ============================================================================
 */

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiUrl } from '@/lib/api';
import {
  ApiError,
  apiFetch,
  safeNextPath,
  setToken,
  type AuthProviders,
  type AuthResponse,
} from '@/lib/auth';
import { useAuth } from '@/components/AuthProvider';

type Mode = 'signin' | 'signup';

/** Used until /auth/providers answers (or if it can't be reached). */
const DEFAULT_MIN_PASSWORD = 8;

/** How long to lock the submit button after TOO_MANY_ATTEMPTS. */
const LOCKOUT_SECONDS = 60;

/**
 * A deliberately loose email check — just "something@something.something".
 * The backend does the real validation; this only catches obvious typos
 * before we bother the server.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The error box's contents: a bold headline, a tip, and a code to act on. */
interface ShownError {
  message: string;
  tip?: string;
  code: string;
}

// ============================================================================
// Small presentational pieces
// ============================================================================

/** Google's "G" in its four brand colours. */
function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" className="w-4 h-4" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** Apple's logo, monochrome (it inherits the text colour via currentColor). */
function AppleLogo() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden="true">
      <path d="M16.37 12.62c-.02-2.3 1.88-3.41 1.97-3.46-1.07-1.57-2.74-1.78-3.33-1.8-1.42-.14-2.77.84-3.49.84-.72 0-1.83-.82-3.01-.8-1.55.02-2.98.9-3.78 2.29-1.61 2.8-.41 6.94 1.16 9.21.77 1.11 1.68 2.36 2.88 2.31 1.16-.05 1.6-.75 3-.75s1.79.75 3.01.72c1.25-.02 2.04-1.13 2.8-2.24.88-1.29 1.24-2.53 1.26-2.6-.03-.01-2.42-.93-2.44-3.68zM14.08 5.87c.64-.78 1.07-1.85.95-2.92-.92.04-2.04.61-2.7 1.39-.59.69-1.11 1.78-.97 2.83 1.03.08 2.07-.52 2.72-1.3z" />
    </svg>
  );
}

/** A tiny rotating ring used inside buttons while something is happening. */
function Spinner() {
  return (
    <span
      className="inline-block w-3.5 h-3.5 rounded-full border-2 border-current border-r-transparent animate-spin"
      aria-hidden="true"
    />
  );
}

/** One row of the password checklist: ✓ in green when met, · in grey when not. */
function CheckItem({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={`flex items-center gap-2 ${ok ? 'text-neon-lime' : 'text-slate-500'}`}>
      <span className="w-3 text-center" aria-hidden="true">{ok ? '✓' : '·'}</span>
      {children}
      {/* Screen readers can't see colour, so say it in words too. */}
      <span className="sr-only">{ok ? '(done)' : '(not yet)'}</span>
    </li>
  );
}

/** A red message shown under a field that failed validation. */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-[0.72rem] text-neon-pink">
      {message}
    </p>
  );
}

// Shared class strings, so every field looks identical.
const INPUT_CLASS = 'input-neon w-full px-3 py-2';
const FIELD_LABEL_CLASS = 'block mb-1 text-[0.7rem] uppercase tracking-label text-slate-400';

// ============================================================================
// The page
// ============================================================================

/**
 * The exported page just adds the Suspense boundary (see header). The
 * `fallback` is what shows during the split second before LoginInner can run.
 */
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="py-16 text-center font-mono text-[0.8rem] tracking-label text-neon-cyan/80">
          &gt; LOADING…
        </div>
      }
    >
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading, refresh, signOut } = useAuth();

  // Where to go after signing in. safeNextPath refuses anything that would
  // leave this site (e.g. "//evil.com"), falling back to /machines.
  const next = safeNextPath(searchParams.get('next'));

  // ---- Form state (each useState is one piece of the component's memory) ----
  const [mode, setMode] = useState<Mode>(
    searchParams.get('mode') === 'signup' ? 'signup' : 'signin',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  /** Per-field messages from client-side validation. */
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string; confirm?: string }>({});
  /** The box at the top for errors from the server. */
  const [serverError, setServerError] = useState<ShownError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** True once sign-in worked, so we show "redirecting" instead of the form. */
  const [done, setDone] = useState(false);
  /** Draw attention to the Google/Apple buttons (after USE_SOCIAL_LOGIN). */
  const [highlightSocial, setHighlightSocial] = useState(false);
  /** Which social button was clicked, to show a spinner on it. */
  const [socialPending, setSocialPending] = useState<'google' | 'apple' | null>(null);

  // ---- Lockout countdown (TOO_MANY_ATTEMPTS) ----
  const [lockSecondsLeft, setLockSecondsLeft] = useState(0);

  // ---- Which sign-in methods the server offers ----
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersFailed, setProvidersFailed] = useState(false);

  // useRef = a value that survives re-draws WITHOUT causing one when changed.
  // Here: the email input element, so we can focus it after switching tabs.
  const emailRef = useRef<HTMLInputElement>(null);

  const minLength = providers?.minPasswordLength ?? DEFAULT_MIN_PASSWORD;

  // Load /auth/providers once when the page opens.
  useEffect(() => {
    // AbortController lets us cancel the request if the page is left early,
    // so we never try to update a component that no longer exists.
    const controller = new AbortController();
    apiFetch<AuthProviders>('/auth/providers', { signal: controller.signal })
      .then((p) => setProviders(p))
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setProvidersFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setProvidersLoading(false);
      });
    return () => controller.abort();
  }, []);

  // Tick the lockout countdown down once a second while it's running.
  useEffect(() => {
    if (lockSecondsLeft <= 0) return;
    const t = setTimeout(() => setLockSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [lockSecondsLeft]);

  // When the browser returns here with the Back button after starting a
  // Google/Apple sign-in, clear the button spinner. ('pageshow' fires even
  // when the page is restored from the browser's back/forward cache.)
  useEffect(() => {
    const reset = () => setSocialPending(null);
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  // ---- Live password checklist (create-account only) ----
  const checks = {
    length: password.length >= minLength,
    // /^(.)\1*$/ = "one character, then that same character repeated" —
    // i.e. "aaaaaaaa" or "11111111", which are trivially guessable.
    notRepeated: password.length > 0 && !/^(.)\1*$/.test(password),
    matches: password.length > 0 && password === confirm,
  };

  /** Switch tabs, keep the email, clear everything else that no longer applies. */
  const switchMode = (m: Mode) => {
    setMode(m);
    setFieldErrors({});
    setServerError(null);
    setHighlightSocial(false);
    setPassword('');
    setConfirm('');
    // Keep the URL in step, so reload/back/share keeps the right tab.
    const params = new URLSearchParams(searchParams.toString());
    if (m === 'signup') params.set('mode', 'signup');
    else params.delete('mode');
    const qs = params.toString();
    router.replace(`/login${qs ? `?${qs}` : ''}`, { scroll: false });
    // Focus the email box on the next frame (after React has re-drawn).
    requestAnimationFrame(() => emailRef.current?.focus());
  };

  /** Client-side checks. Returns true if OK to send. */
  const validate = (): boolean => {
    const errs: typeof fieldErrors = {};
    if (!email.trim()) errs.email = 'Enter your email address.';
    else if (!EMAIL_RE.test(email.trim())) errs.email = "That doesn't look like an email address.";

    if (!password) errs.password = 'Enter your password.';
    else if (mode === 'signup') {
      if (!checks.length) errs.password = `Use at least ${minLength} characters.`;
      else if (!checks.notRepeated) errs.password = "Use more than one repeated character.";
      if (!confirm) errs.confirm = 'Type the password again to confirm it.';
      else if (!checks.matches) errs.confirm = "The two passwords don't match.";
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  /** Form submit: validate, call the backend, handle the answer. */
  const handleSubmit = async (e: React.FormEvent) => {
    // Stop the browser's default "reload the page with the form data".
    e.preventDefault();
    if (submitting || lockSecondsLeft > 0) return;
    setServerError(null);
    setHighlightSocial(false);
    if (!validate()) return;

    setSubmitting(true);
    try {
      const body =
        mode === 'signup'
          ? { email: email.trim(), password, displayName: displayName.trim() || undefined }
          : { email: email.trim(), password };
      const res = await apiFetch<AuthResponse>(
        mode === 'signup' ? '/auth/register' : '/auth/login',
        { method: 'POST', body },
      );
      setToken(res.token);
      setDone(true);
      await refresh();
      router.replace(next);
    } catch (err) {
      const apiErr =
        err instanceof ApiError
          ? err
          : new ApiError('Something went wrong.', 0, 'UNKNOWN', 'Please try again.');
      setServerError({ message: apiErr.message, tip: apiErr.tip, code: apiErr.code });

      // Special cases that change the page, not just the message:
      if (apiErr.code === 'USE_SOCIAL_LOGIN') setHighlightSocial(true);
      if (apiErr.code === 'TOO_MANY_ATTEMPTS') setLockSecondsLeft(LOCKOUT_SECONDS);
      if (apiErr.code === 'BAD_CREDENTIALS') setPassword('');
      setSubmitting(false);
    }
  };

  // ==========================================================================
  // What to draw
  // ==========================================================================

  // Sign-in just worked — say so while the redirect happens.
  if (done) {
    return (
      <Shell>
        <p className="py-6 text-center font-mono text-[0.8rem] tracking-label text-neon-lime" role="status">
          &gt; SIGNED_IN — redirecting…
        </p>
      </Shell>
    );
  }

  // Already signed in (e.g. visited /login directly).
  if (!authLoading && user) {
    return (
      <Shell>
        <div className="space-y-4 text-center py-2">
          <p className="text-[0.85rem] text-slate-300">
            You&apos;re signed in as{' '}
            <span className="text-neon-cyan break-all">{user.displayName || user.email}</span>.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 justify-center">
            <button type="button" className="btn-neon" onClick={() => router.replace(next)}>
              Continue →
            </button>
            <button type="button" className="btn-neon-pink" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  const googleOn = !!providers?.google;
  const appleOn = !!providers?.apple;
  const anySocial = googleOn || appleOn;
  const locked = lockSecondsLeft > 0;
  const socialHref = (p: 'google' | 'apple') =>
    apiUrl(`/auth/oauth/${p}/start?next=${encodeURIComponent(next)}`);

  // Admin hint: which server env vars are missing for the social buttons.
  const missingHints = providers
    ? [
        ...(!googleOn ? providers.setupHints?.google ?? [] : []),
        ...(!appleOn ? providers.setupHints?.apple ?? [] : []),
      ]
    : [];

  return (
    <Shell>
      {/* ---- Tabs ----
          role="tablist"/"tab" + aria-selected tell screen readers these
          behave as tabs, and which one is chosen. */}
      <div role="tablist" aria-label="Sign in or create an account" className="grid grid-cols-2 mb-5 border border-white/10 rounded p-0.5 bg-cyber-darker/60">
        {(['signin', 'signup'] as const).map((m) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => !active && switchMode(m)}
              className={`py-1.5 rounded-sm text-[0.72rem] uppercase tracking-label transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-neon-cyan/70 ${
                active
                  ? 'bg-neon-cyan/[0.1] text-neon-cyan shadow-[inset_0_0_0_1px_rgba(95,215,224,0.35)]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {m === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          );
        })}
      </div>

      {/* ---- Google / Apple ---- */}
      {providersLoading ? (
        // Skeleton placeholders the same size as the real buttons.
        <div className="space-y-2 mb-5" aria-hidden="true">
          <div className="h-9 rounded bg-white/[0.04] border border-white/[0.06] animate-pulse" />
          <div className="h-9 rounded bg-white/[0.04] border border-white/[0.06] animate-pulse" />
        </div>
      ) : anySocial ? (
        <div
          className={`space-y-2 mb-5 rounded transition-shadow ${
            highlightSocial ? 'p-2 -m-2 mb-3 ring-1 ring-neon-amber/60 shadow-[0_0_18px_-4px_rgba(232,184,99,0.5)]' : ''
          }`}
        >
          {highlightSocial && (
            <p className="text-[0.72rem] text-neon-amber px-1">
              This account uses Google or Apple — continue with the one you signed up with:
            </p>
          )}
          {googleOn && (
            // A real link (<a>), not fetch — the whole page must go to Google.
            <a
              href={socialHref('google')}
              onClick={() => setSocialPending('google')}
              className="w-full h-9 inline-flex items-center justify-center gap-2.5 rounded border border-white/15 bg-white/[0.03] hover:bg-white/[0.07] text-[0.8rem] text-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/50"
            >
              {socialPending === 'google' ? <Spinner /> : <GoogleLogo />}
              Continue with Google
            </a>
          )}
          {appleOn && (
            <a
              href={socialHref('apple')}
              onClick={() => setSocialPending('apple')}
              className="w-full h-9 inline-flex items-center justify-center gap-2.5 rounded border border-white/15 bg-white/[0.03] hover:bg-white/[0.07] text-[0.8rem] text-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/50"
            >
              {socialPending === 'apple' ? <Spinner /> : <AppleLogo />}
              Continue with Apple
            </a>
          )}
          {/* One provider on, the other off: a quiet note for admins. */}
          {missingHints.length > 0 && <SetupHints hints={missingHints} partial />}
        </div>
      ) : providersFailed ? null : (
        <div className="mb-5">
          <p className="text-[0.72rem] text-slate-500">
            Google / Apple sign-in isn&apos;t set up on this server yet.
          </p>
          {missingHints.length > 0 && <SetupHints hints={missingHints} />}
        </div>
      )}

      {/* "or" divider — only when there are social buttons above it */}
      {anySocial && !providersLoading && (
        <div className="flex items-center gap-3 mb-5 text-[0.65rem] uppercase tracking-label text-slate-600" aria-hidden="true">
          <span className="flex-1 h-px bg-white/[0.08]" />
          or with email
          <span className="flex-1 h-px bg-white/[0.08]" />
        </div>
      )}

      {/* ---- Server error box ----
          role="alert" makes screen readers announce it as soon as it appears. */}
      {serverError && (
        <div role="alert" className="mb-4 rounded border border-neon-pink/40 bg-neon-pink/[0.06] px-3 py-2.5 text-[0.78rem]">
          <p className="font-semibold text-neon-pink">{serverError.message}</p>
          {serverError.tip && <p className="mt-1 text-slate-300">{serverError.tip}</p>}
          {serverError.code === 'EMAIL_TAKEN' && (
            <button
              type="button"
              onClick={() => switchMode('signin')}
              className="mt-2 text-neon-cyan underline underline-offset-2 hover:text-slate-100"
            >
              Sign in instead →
            </button>
          )}
          {serverError.code === 'NETWORK' && !serverError.tip && (
            <p className="mt-1 text-slate-300">
              Can&apos;t reach the backend — check the BACKEND light / NEXT_PUBLIC_API_URL.
            </p>
          )}
          {locked && (
            <p className="mt-1 text-neon-amber">You can try again in {lockSecondsLeft}s.</p>
          )}
        </div>
      )}

      {/* ---- Email/password form ----
          noValidate turns off the browser's own pop-up validation so our
          friendlier inline messages are used instead. */}
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {mode === 'signup' && (
          <div>
            <label htmlFor="displayName" className={FIELD_LABEL_CLASS}>
              Display name <span className="normal-case tracking-normal text-slate-600">(optional)</span>
            </label>
            <input
              id="displayName"
              type="text"
              autoComplete="nickname"
              maxLength={80}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={INPUT_CLASS}
              placeholder="What should we call you?"
            />
          </div>
        )}

        <div>
          <label htmlFor="email" className={FIELD_LABEL_CLASS}>Email</label>
          <input
            ref={emailRef}
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (fieldErrors.email) setFieldErrors((f) => ({ ...f, email: undefined }));
            }}
            className={INPUT_CLASS}
            placeholder="you@example.com"
            aria-invalid={!!fieldErrors.email}
            aria-describedby={fieldErrors.email ? 'email-error' : undefined}
          />
          <FieldError id="email-error" message={fieldErrors.email} />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="password" className={FIELD_LABEL_CLASS + ' mb-0'}>Password</label>
            {/* Show/hide toggle: flips the input between type="password" and "text". */}
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="text-[0.68rem] uppercase tracking-label text-slate-500 hover:text-neon-cyan focus:outline-none focus-visible:text-neon-cyan"
              aria-pressed={showPassword}
              aria-controls="password"
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
          <input
            id="password"
            type={showPassword ? 'text' : 'password'}
            // Tells password managers whether to fill a saved password or
            // offer to generate a new one.
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
            }}
            className={INPUT_CLASS}
            aria-invalid={!!fieldErrors.password}
            aria-describedby={
              [fieldErrors.password ? 'password-error' : '', mode === 'signup' ? 'password-checklist' : '']
                .filter(Boolean)
                .join(' ') || undefined
            }
          />
          <FieldError id="password-error" message={fieldErrors.password} />
        </div>

        {mode === 'signup' && (
          <>
            <div>
              <label htmlFor="confirm" className={FIELD_LABEL_CLASS}>Confirm password</label>
              <input
                id="confirm"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  if (fieldErrors.confirm) setFieldErrors((f) => ({ ...f, confirm: undefined }));
                }}
                className={INPUT_CLASS}
                aria-invalid={!!fieldErrors.confirm}
                aria-describedby={fieldErrors.confirm ? 'confirm-error' : undefined}
              />
              <FieldError id="confirm-error" message={fieldErrors.confirm} />
            </div>

            {/* The live checklist — re-evaluated on every keystroke because
                `checks` is recalculated each time the component re-draws. */}
            <ul id="password-checklist" className="space-y-0.5 text-[0.72rem]" aria-live="polite">
              <CheckItem ok={checks.length}>At least {minLength} characters</CheckItem>
              <CheckItem ok={checks.notRepeated}>Not just one character repeated</CheckItem>
              <CheckItem ok={checks.matches}>Both passwords match</CheckItem>
            </ul>
          </>
        )}

        <button
          type="submit"
          disabled={submitting || locked}
          className="btn-neon w-full py-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:shadow-none focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/50"
        >
          {submitting ? (
            <>
              <Spinner />
              {mode === 'signup' ? 'Creating account…' : 'Signing in…'}
            </>
          ) : locked ? (
            `Try again in ${lockSecondsLeft}s`
          ) : mode === 'signup' ? (
            'Create account'
          ) : (
            'Sign in'
          )}
        </button>
      </form>

      {/* Quick way across for people on the wrong tab. */}
      <p className="mt-5 text-center text-[0.75rem] text-slate-500">
        {mode === 'signin' ? (
          <>
            New here?{' '}
            <button type="button" onClick={() => switchMode('signup')} className="text-neon-cyan hover:underline underline-offset-2">
              Create an account
            </button>
          </>
        ) : (
          <>
            Already have an account?{' '}
            <button type="button" onClick={() => switchMode('signin')} className="text-neon-cyan hover:underline underline-offset-2">
              Sign in
            </button>
          </>
        )}
      </p>
    </Shell>
  );
}

/**
 * The expandable "for admins" list of missing server settings.
 * <details>/<summary> is a built-in HTML expander — no React state needed.
 */
function SetupHints({ hints, partial = false }: { hints: string[]; partial?: boolean }) {
  return (
    <details className="mt-1.5 text-[0.7rem] text-slate-500 group">
      <summary className="cursor-pointer select-none hover:text-slate-300 focus:outline-none focus-visible:text-neon-cyan">
        {partial ? 'Other sign-in options need setup' : 'Admin: what to set up'}
      </summary>
      <p className="mt-1.5">Set these environment variables on the backend, then redeploy it:</p>
      <ul className="mt-1 space-y-0.5">
        {hints.map((h) => (
          <li key={h}>
            <code>{h}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The centred card with the page title and the reassurance footer — shared
 * by every state of the page so the layout never jumps.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center py-4 sm:py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-5 text-center">
          <p className="label mb-1">[ ACCESS_TERMINAL ]</p>
          <h1 className="text-lg neon-text">Welcome to Gints Global Gaming Hubjob</h1>
        </div>
        <div className="neon-card rounded-md p-5 sm:p-6">{children}</div>
        <p className="mt-4 px-2 text-center text-[0.7rem] leading-relaxed text-slate-500">
          <span className="text-neon-lime" aria-hidden="true">[ENC] </span>
          Your cloud keys are encrypted before they&apos;re stored and are never shown again after saving.
        </p>
        <p className="mt-2 text-center text-[0.68rem] text-slate-600">
          <Link href="/" className="hover:text-slate-300">← Back to dashboard</Link>
        </p>
      </div>
    </div>
  );
}
