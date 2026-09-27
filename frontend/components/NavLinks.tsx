'use client';
// ↑ Must be the very first line: marks this as a CLIENT component (runs in
//   the browser), needed because it reads the current URL as you navigate.

/**
 * ============================================================================
 * frontend/components/NavLinks.tsx — THE PAGE LINKS IN THE HEADER
 * ============================================================================
 *
 * Shows Dashboard / Machines / Performance / ... and highlights (cyan text
 * + a glowing underline) whichever page you're currently on.
 * Used by app/layout.tsx.
 * ============================================================================
 */

// Next.js's <Link> works like an <a> tag but switches pages WITHOUT a full
// page reload (faster, keeps state like the status bar alive).
import Link from 'next/link';
// usePathname() gives the current URL path, e.g. "/machines".
import { usePathname } from 'next/navigation';

// The menu, as data. Adding a page to the nav = adding one line here.
const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/machines', label: 'Machines' },
  { href: '/performance', label: 'Performance' },
  { href: '/recommendations', label: 'Recon' },
  { href: '/costs', label: 'Costs' },
  { href: '/settings', label: 'Config' },
];

export default function NavLinks() {
  // A React HOOK (functions starting with "use" are hooks). When the URL
  // changes, React re-runs this component with the new pathname, so the
  // highlight moves automatically.
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto">
      {/* .map turns each item in LINKS into a <Link> element. */}
      {LINKS.map(({ href, label }) => {
        // Is this the current page? The home link '/' must match exactly
        // (otherwise EVERY path, since they all start with '/', would count).
        // Others use startsWith so sub-pages (e.g. /machines/123) still
        // highlight their section.
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          // `key` is required when rendering a list: React uses it to tell
          // the items apart efficiently between re-renders.
          <Link
            key={href}
            href={href}
            // Template string: fixed classes, plus cyan if active or grey
            // (lighter on hover) if not.
            className={`relative px-3 h-12 inline-flex items-center text-[0.72rem] uppercase tracking-label whitespace-nowrap transition-colors ${
              active ? 'text-neon-cyan' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {label}
            {/* `condition && <X />` = show X only when condition is true. The
                1px glowing line along the bottom edge of the active link. */}
            {active && (
              <span className="absolute left-3 right-3 bottom-0 h-px bg-neon-cyan shadow-[0_0_8px_rgba(95,215,224,0.8)]" />
            )}
          </Link>
        );
      })}
    </div>
  );
}
