'use client';
// ↑ Client component: it reads the live sign-in state from AuthProvider.

/**
 * ============================================================================
 * frontend/components/UserMenu.tsx — "SIGNED IN AS …" IN THE HEADER
 * ============================================================================
 *
 * Sits at the right-hand end of the 48px header (app/layout.tsx).
 *   signed in   →  ● ALEX@EXAMPLE.COM   [Sign out]
 *   signed out  →  Sign in
 *   checking    →  a faint placeholder so the header doesn't jump around
 *
 * Needs to be inside <AuthProvider> (it uses the useAuth() hook).
 * ============================================================================
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';

export default function UserMenu() {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // While the saved token is being checked, reserve the space quietly.
  if (loading) {
    return (
      <div
        className="h-3 w-24 rounded-sm bg-white/[0.05] animate-pulse flex-shrink-0"
        aria-hidden="true"
      />
    );
  }

  if (!user) {
    // Don't bounce people back to /login after signing in from /login itself.
    const next = pathname && pathname !== '/login' && !pathname.startsWith('/auth/')
      ? `?next=${encodeURIComponent(pathname)}`
      : '';
    return (
      <Link
        href={`/login${next}`}
        className="flex-shrink-0 h-12 inline-flex items-center px-3 text-[0.72rem] uppercase tracking-label text-neon-cyan hover:text-slate-100 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-neon-cyan/60 rounded-sm"
      >
        Sign in
      </Link>
    );
  }

  // Prefer the display name; fall back to the email address.
  const name = user.displayName?.trim() || user.email;

  const handleSignOut = () => {
    signOut();
    // Send them somewhere public; members-only pages would redirect anyway.
    router.replace('/login');
  };

  return (
    <div className="flex items-center gap-3 flex-shrink-0 min-w-0">
      {/* "title" shows the full name/email on hover when it's been truncated */}
      <span
        className="hidden sm:inline-flex items-center gap-2 min-w-0 text-[0.72rem] uppercase tracking-label text-slate-300"
        title={user.email}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-neon-lime shadow-[0_0_6px_rgba(143,214,148,0.8)] flex-shrink-0" />
        {/* "truncate" = cut off long text with "…"; max-w stops it pushing the nav */}
        <span className="truncate max-w-[10rem] lg:max-w-[14rem]">{name}</span>
      </span>
      <button
        type="button"
        onClick={handleSignOut}
        className="text-[0.68rem] uppercase tracking-label text-slate-400 hover:text-neon-pink border border-white/10 hover:border-neon-pink/40 rounded-sm px-2 py-0.5 transition-colors whitespace-nowrap focus:outline-none focus-visible:ring-1 focus-visible:ring-neon-pink/60"
      >
        Sign out
      </button>
    </div>
  );
}
