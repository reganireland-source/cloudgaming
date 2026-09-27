'use client';
// ↑ Client component: it reads localStorage and keeps live state in the browser.

/**
 * ============================================================================
 * frontend/components/AuthProvider.tsx — "WHO IS SIGNED IN?" FOR THE WHOLE APP
 * ============================================================================
 *
 * Wrap the app in <AuthProvider> once (in app/layout.tsx). Then ANY
 * component, however deep, can ask:
 *
 *     const { user, loading, signOut, refresh } = useAuth();
 *
 *   user     — the signed-in user, or null if signed out
 *   loading  — true while we're still checking the saved token on page load
 *   signOut  — forget the token and become signed out
 *   refresh  — re-ask the backend who we are (call right after setToken())
 *
 * Also exported: <RequireAuth>, a wrapper for pages that need a signed-in
 * user — it sends signed-out visitors to /login and brings them back after.
 *
 * REACT CONCEPT: CONTEXT
 * ----------------------
 * Normally data is passed down component-by-component as props. CONTEXT is
 * React's way of making one value available to every component inside a
 * provider without threading it through each level. createContext() makes
 * the "channel", <AuthContext.Provider value={...}> broadcasts on it, and
 * useContext(AuthContext) (wrapped here as useAuth()) tunes in. Whenever the
 * value changes, every component using it re-draws.
 * ============================================================================
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  ApiError,
  AUTH_EXPIRED_EVENT,
  apiFetch,
  clearToken,
  getToken,
  type AuthUser,
} from '@/lib/auth';

/** The shape of what useAuth() gives you. */
export interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  signOut: () => void;
  /** Re-check the session. Resolves to the user (or null if signed out). */
  refresh: () => Promise<AuthUser | null>;
}

// The "channel". The default value is only used if a component calls
// useAuth() OUTSIDE an <AuthProvider> — we treat that as "signed out".
const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: false,
  signOut: () => {},
  refresh: async () => null,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  // Start as "loading" so pages don't flash "signed out" for a split second
  // before we've had a chance to check the saved token.
  const [loading, setLoading] = useState(true);

  /**
   * Ask the backend who the saved token belongs to.
   * useCallback keeps the SAME function object between re-draws, so effects
   * that depend on it don't re-run needlessly.
   */
  const refresh = useCallback(async (): Promise<AuthUser | null> => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return null;
    }
    try {
      const { user: me } = await apiFetch<{ user: AuthUser }>('/auth/me');
      setUser(me);
      return me;
    } catch (err) {
      // 401: apiFetch already cleared the token for us. Anything else (e.g.
      // the backend is briefly down) we treat as signed-out for now but KEEP
      // the token, so a reload once the backend is back signs you in again.
      if (err instanceof ApiError && err.status === 401) clearToken();
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  // On first appearance: check the saved token. Then listen for:
  //  - AUTH_EXPIRED_EVENT: apiFetch got a 401 somewhere → we're signed out
  //  - 'storage': fired when ANOTHER TAB changes localStorage, so signing in
  //    or out in one tab updates all your open tabs.
  useEffect(() => {
    refresh();

    const onExpired = () => setUser(null);
    const onStorage = (e: StorageEvent) => {
      // e.key is null when storage was cleared entirely.
      if (e.key === 'cg_token' || e.key === null) refresh();
    };

    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    window.addEventListener('storage', onStorage);
    // Cleanup: stop listening if the provider is ever removed.
    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
      window.removeEventListener('storage', onStorage);
    };
  }, [refresh]);

  // useMemo: only build a new value object when something in it changed, so
  // consumers don't re-draw on every render of the provider.
  const value = useMemo(
    () => ({ user, loading, signOut, refresh }),
    [user, loading, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** The hook every component uses to read the current session. */
export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

/**
 * Wrap a page's content in <RequireAuth> to make it members-only:
 *   - still checking  → a small "> CHECKING_SESSION…" line
 *   - signed out      → go to /login?next=<this page>, which sends you back here
 *   - signed in       → show the page
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // Redirecting is a "side effect" (it changes something outside this
  // component), so it belongs in useEffect rather than directly in render.
  useEffect(() => {
    if (!loading && !user) {
      router.replace(`/login?next=${encodeURIComponent(pathname || '/')}`);
    }
  }, [loading, user, router, pathname]);

  if (loading) {
    return (
      <div className="py-16 text-center font-mono text-[0.8rem] tracking-label text-neon-cyan/80" role="status">
        &gt; CHECKING_SESSION…
      </div>
    );
  }

  if (!user) {
    return (
      <div className="py-16 text-center font-mono text-[0.8rem] text-slate-400" role="status">
        Redirecting to sign in…
      </div>
    );
  }

  return <>{children}</>;
}

export default AuthProvider;
