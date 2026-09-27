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
import { useEffect, useState } from 'react';
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
  { href: '/map', label: 'Map' },
  { href: '/settings', label: 'Config' },
];

export default function NavLinks() {
  // A React HOOK (functions starting with "use" are hooks). When the URL
  // changes, React re-runs this component with the new pathname, so the
  // highlight moves automatically.
  const pathname = usePathname();
  // Small screens: the links live in a drop-down menu behind a ☰ button.
  const [menuOpen, setMenuOpen] = useState(false);
  // Close the menu whenever you navigate to another page.
  useEffect(() => setMenuOpen(false), [pathname]);

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const current = LINKS.find((l) => isActive(l.href));

  return (
    <>
      {/* ---- Wide screens (md = 768px+): the usual row of links ---- */}
      <div className="hidden md:flex items-center gap-0.5">
        {/* .map turns each item in LINKS into a <Link> element. */}
        {LINKS.map(({ href, label }) => {
          const active = isActive(href);
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
              {/* The 1px glowing line along the bottom edge of the active link. */}
              {active && (
                <span className="absolute left-3 right-3 bottom-0 h-px bg-neon-cyan shadow-[0_0_8px_rgba(95,215,224,0.8)]" />
              )}
            </Link>
          );
        })}
      </div>

      {/* ---- Small screens: current page name + ☰ menu button ---- */}
      <div className="md:hidden flex items-center">
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          className="h-10 inline-flex items-center gap-2 px-2.5 rounded border border-white/10 text-[0.72rem] uppercase tracking-label text-slate-200"
        >
          <span className="text-neon-cyan">{current?.label || 'Menu'}</span>
          <span aria-hidden className="text-base leading-none">{menuOpen ? '✕' : '☰'}</span>
        </button>
      </div>

      {/* The drop-down: full width under the header, big finger-sized rows.
          It scrolls itself if the screen is very short. */}
      {menuOpen && (
        <div id="mobile-menu" className="md:hidden fixed left-0 right-0 top-12 z-[60] border-b border-white/10 bg-cyber-darker max-h-[calc(100dvh-3rem)] overflow-y-auto shadow-2xl">
          <nav className="grid grid-cols-2 gap-px bg-white/5 p-px" aria-label="Pages">
            {LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={`px-4 py-3.5 text-sm uppercase tracking-label bg-cyber-darker ${isActive(href) ? 'text-neon-cyan' : 'text-slate-300'}`}
              >
                {isActive(href) ? '▸ ' : ''}{label}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </>
  );
}
