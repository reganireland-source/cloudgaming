'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/machines', label: 'Machines' },
  { href: '/performance', label: 'Performance' },
  { href: '/recommendations', label: 'Recon' },
  { href: '/costs', label: 'Costs' },
  { href: '/settings', label: 'Config' },
];

export default function NavLinks() {
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto">
      {LINKS.map(({ href, label }) => {
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`relative px-3 h-12 inline-flex items-center text-[0.72rem] uppercase tracking-label whitespace-nowrap transition-colors ${
              active ? 'text-neon-cyan' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {label}
            {active && (
              <span className="absolute left-3 right-3 bottom-0 h-px bg-neon-cyan shadow-[0_0_8px_rgba(95,215,224,0.8)]" />
            )}
          </Link>
        );
      })}
    </div>
  );
}
