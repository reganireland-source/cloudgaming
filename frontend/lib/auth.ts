/**
 * ============================================================================
 * frontend/lib/auth.ts — WHO IS SIGNED IN, AND HOW WE TALK TO THE BACKEND AS THEM
 * ============================================================================
 *
 * THE BIG PICTURE
 * ---------------
 * When you sign in (app/login/page.tsx or Google/Apple via
 * app/auth/callback/page.tsx) the backend hands us a TOKEN: a long random-
 * looking string that proves "this browser belongs to user X" for a while.
 * We keep it in the browser's localStorage (a small key/value store that
 * survives page reloads) under the key 'cg_token', and send it with every
 * backend request in an HTTP header:
 *
 *     Authorization: Bearer <token>
 *
 * The backend checks that header to decide who you are.
 *
 * WHAT'S IN THIS FILE
 * -------------------
 *   getToken / setToken / clearToken  — read/write/delete the stored token
 *   ApiError                          — the error type every failed call throws
 *   apiFetch<T>(path, init)           — fetch() + JSON + token + error handling
 *
 * The React side (who is signed in right now, the useAuth() hook) lives in
 * components/AuthProvider.tsx, because hooks and components belong in .tsx.
 *
 * WHY "typeof window" CHECKS?
 * ---------------------------
 * Next.js also runs our code on the SERVER to pre-build HTML. There is no
 * `window` or `localStorage` on the server, so touching them there would
 * crash. `typeof window === 'undefined'` is the safe way to ask "am I on the
 * server?". We also wrap storage in try/catch because some browsers (private
 * mode, blocked cookies) throw when you touch localStorage at all.
 * ============================================================================
 */

import { apiUrl } from './api';

/** The localStorage key the token is saved under. */
const TOKEN_KEY = 'cg_token';

/** The browser event we fire when the backend says our token is no good. */
export const AUTH_EXPIRED_EVENT = 'cg-auth-expired';

// ----------------------------------------------------------------------------
// Token storage
// ----------------------------------------------------------------------------

/** The saved token, or null if signed out (or on the server). */
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // storage blocked — behave as signed out
  }
}

/** Save a token after a successful sign-in. */
export function setToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage blocked — nothing we can do; the user will stay signed out
  }
}

/** Forget the token (sign out, or the backend rejected it). */
export function clearToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

// ----------------------------------------------------------------------------
// Types shared with the backend
// ----------------------------------------------------------------------------

/** A signed-in user, exactly as GET /api/auth/me returns it. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  hasPassword: boolean;
  /** Which sign-in methods are linked, e.g. ['password', 'google']. */
  identities: string[];
}

/** What POST /auth/login and /auth/register answer with on success. */
export interface AuthResponse {
  token: string;
  user: AuthUser;
}

/** What GET /auth/providers answers with (which sign-in buttons to show). */
export interface AuthProviders {
  password: boolean;
  google: boolean;
  apple: boolean;
  minPasswordLength: number;
  /** Names of server env vars an admin still needs to set, per provider. */
  setupHints: { google: string[]; apple: string[] };
}

/**
 * A human-friendly explanation some backend endpoints (mostly cloud-provider
 * calls) attach to their errors under the key `friendly`.
 */
export interface FriendlyError {
  code: string;
  title: string;
  explanation: string;
  fixes: string[];
  consoleUrl?: string;
  consoleLabel?: string;
  raw?: string;
  /** Why it failed (quota, region, permission, capacity, credentials, account, other). */
  cause?: 'quota' | 'region' | 'permission' | 'capacity' | 'credentials' | 'account' | 'other';
}

// ----------------------------------------------------------------------------
// ApiError
// ----------------------------------------------------------------------------

/**
 * The error apiFetch throws when a request fails. It's a normal JavaScript
 * Error (so `err.message` works) with extra fields from the backend's error
 * body `{ error, code, tip, friendly }`:
 *   status  — HTTP status (401, 409...), or 0 if we never reached the server
 *   code    — a stable machine-readable name, e.g. 'EMAIL_TAKEN'. Check THIS
 *             in code, not the message text (messages may be reworded).
 *   tip     — an optional "here's what to try" sentence for the user
 *   friendly— an optional richer explanation (see FriendlyError)
 */
export class ApiError extends Error {
  status: number;
  code: string;
  tip?: string;
  friendly?: FriendlyError;
  /** The whole parsed JSON reply, for endpoints that send extra detail with
   *  an error (e.g. the credential checklist on a 422). */
  body?: any;

  constructor(
    message: string,
    status: number,
    code: string,
    tip?: string,
    friendly?: FriendlyError,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.tip = tip;
    this.friendly = friendly;
  }
}

// ----------------------------------------------------------------------------
// apiFetch
// ----------------------------------------------------------------------------

export interface ApiFetchInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Any JS value; it's turned into JSON for you. */
  body?: unknown;
  /** Lets the caller cancel the request (see AbortController). */
  signal?: AbortSignal;
}

/**
 * Call the backend and get back parsed JSON.
 *
 * The `<T>` is a TypeScript "generic": the caller says what shape it expects,
 * e.g. `apiFetch<{ user: AuthUser }>('/auth/me')`, and the result is typed
 * accordingly. (TypeScript trusts you here — it can't check the real JSON.)
 *
 * On failure it THROWS an ApiError, so callers use try/catch:
 *     try { const r = await apiFetch<X>('/thing'); } catch (e) { ... }
 */
export async function apiFetch<T>(path: string, init: ApiFetchInit = {}): Promise<T> {
  const token = getToken();

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
      cache: 'no-store',
    });
  } catch (err) {
    // If the caller cancelled on purpose, pass that through unchanged so they
    // can recognise it (err.name === 'AbortError') and ignore it.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    // fetch() only throws when there was no HTTP answer at all: the backend
    // is down, the URL is wrong, CORS blocked it, or you're offline.
    throw new ApiError(
      'Could not reach the server.',
      0,
      'NETWORK',
      "Can't reach the backend — check the BACKEND light / NEXT_PUBLIC_API_URL",
    );
  }

  // Read the body as text first, then TRY to parse it as JSON. Some errors
  // (a proxy's HTML 502 page, an empty 204) aren't JSON, and res.json()
  // would throw on those.
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    // 401 = "your token isn't valid (any more)". If we sent one, forget it and
    // tell the rest of the app (AuthProvider listens) so it shows signed-out.
    if (res.status === 401 && token) {
      clearToken();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
      }
    }
    const error = new ApiError(
      (data && typeof data.error === 'string' && data.error) ||
        `Request failed (HTTP ${res.status})`,
      res.status,
      (data && typeof data.code === 'string' && data.code) ||
        (res.status >= 500 ? 'SERVER_ERROR' : `HTTP_${res.status}`),
      data && typeof data.tip === 'string' ? data.tip : undefined,
      data && data.friendly && typeof data.friendly === 'object' ? data.friendly : undefined,
    );
    error.body = data;
    throw error;
  }

  return data as T;
}

/**
 * Only allow "next" redirect targets that stay on THIS site: a path that
 * starts with a single "/". "//evil.com" would be read by the browser as
 * another website, so it's rejected (this is called an "open redirect" guard).
 */
export function safeNextPath(next: string | null | undefined, fallback = '/machines'): string {
  if (!next) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}
