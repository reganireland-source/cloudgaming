/**
 * ============================================================================
 * frontend/app/layout.tsx — THE FRAME AROUND EVERY PAGE
 * ============================================================================
 *
 * HOW NEXT.JS PAGES WORK (the "app router")
 * -----------------------------------------
 * Each folder under app/ is a URL, and its page.tsx is what shows there:
 *     app/page.tsx              ->  /
 *     app/machines/page.tsx     ->  /machines
 *     app/performance/page.tsx  ->  /performance
 * This file, layout.tsx, WRAPS all of them. Whatever page you're on gets
 * placed where `{children}` appears below — so the header, status bar and
 * footer are written once here and appear everywhere.
 *
 * REACT BASICS YOU'LL SEE IN EVERY .tsx FILE
 * ------------------------------------------
 * - A COMPONENT is a function that returns what to show, written in JSX —
 *   HTML-like tags inside JavaScript. <NavLinks /> uses the NavLinks component.
 * - `className` is JSX's word for HTML's `class` (because `class` is a
 *   reserved word in JavaScript).
 * - `{ ... }` inside JSX drops back into JavaScript, e.g. {children}.
 * - PROPS are a component's inputs, like function arguments (here: children).
 *
 * STYLING: TAILWIND CSS
 * ---------------------
 * The long className strings are Tailwind "utility classes": each word is
 * one small style rule. e.g. "flex" = flexbox layout, "px-4" = horizontal
 * padding, "text-slate-500" = a grey text colour, "sm:flex-row" = apply
 * flex-row only on screens at least 640px wide. Our custom colours
 * (neon-cyan, cyber-dark...) are defined in tailwind.config.js; shared
 * classes like neon-card live in app/globals.css.
 *
 * SERVER vs CLIENT COMPONENTS
 * ---------------------------
 * This file has no 'use client' line, so it's a SERVER component: Next.js
 * renders it to HTML ahead of time. Components that need to react in the
 * browser (clicks, timers, live data) start with 'use client' — like
 * NavLinks and SystemStatusBar, which this layout includes.
 * ============================================================================
 */

import type { Metadata } from "next";
import "./globals.css"; // global styles, loaded once for the whole site
// "@/" is a shortcut for the frontend's root folder (set in tsconfig.json),
// so "@/components/X" = frontend/components/X.
import SystemStatusBar from "@/components/SystemStatusBar";
import NavLinks from "@/components/NavLinks";
// Who is signed in, shared with every page (components/AuthProvider.tsx),
// and the "Signed in as … / Sign out" widget in the header.
import { AuthProvider } from "@/components/AuthProvider";
import UserMenu from "@/components/UserMenu";

// Next.js reads this exported object to fill in the page's <title> and
// description (what shows in the browser tab and in search results).
export const metadata: Metadata = {
  title: "CloudGaming Hub",
  description: "Multi-cloud gaming infrastructure — cost, latency and performance across AWS, Azure, GCP and Oracle",
};

/**
 * The root layout. `children` is whatever page is currently being shown.
 * `{ children }: { children: React.ReactNode }` = destructure the props, and
 * declare that children can be anything React can display.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-cyber-dark">
        {/* AuthProvider wraps everything so any page or component can ask
            "who is signed in?" with useAuth(). */}
        <AuthProvider>
        {/* Column layout filling at least the whole screen height, so the footer sits at the bottom even on short pages */}
        <div className="flex flex-col min-h-screen">

          {/* ---- Top header bar ----
              "sticky top-0" keeps it pinned to the top while scrolling;
              "z-50" makes it sit above page content. */}
          <nav className="sticky top-0 z-50 border-b border-white/[0.06] bg-cyber-darker/95 backdrop-blur-md">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="flex justify-between items-center h-12 gap-6">
                {/* Logo / wordmark — links back to the dashboard */}
                <a href="/" className="flex items-center gap-3 flex-shrink-0">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-sm border border-neon-cyan/40 bg-neon-cyan/[0.06] text-neon-cyan text-[0.7rem] shadow-[0_0_10px_-2px_rgba(95,215,224,0.5)]">
                    ▲
                  </span>
                  <span className="text-[0.85rem] font-semibold tracking-[0.14em] text-slate-100">
                    CLOUDGAMING<span className="text-neon-cyan">/</span>HUB
                  </span>
                  {/* Version chip — "hidden md:inline-block" = only shown on medium+ screens */}
                  <span className="hidden md:inline-block text-[0.62rem] tracking-label text-slate-500 border border-white/10 rounded-sm px-1.5 py-px">
                    NEON_CORE v0.1
                  </span>
                </a>
                {/* Page links with the active-page underline (components/NavLinks.tsx),
                    then the signed-in user / Sign in link (components/UserMenu.tsx) */}
                <div className="flex items-center gap-4 min-w-0">
                  <NavLinks />
                  <UserMenu />
                </div>
              </div>
            </div>
          </nav>

          {/* The six connection lights + "Build info" (components/SystemStatusBar.tsx) */}
          <SystemStatusBar />

          {/* ---- The current page goes here ----
              "flex-1" makes this area grow to fill spare height. */}
          <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
            {children}
          </main>

          {/* ---- Footer ---- */}
          <footer className="border-t border-white/[0.06] mt-12">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col sm:flex-row gap-2 justify-between items-center text-[0.68rem] tracking-label uppercase text-slate-500">
              <span>
                <span className="text-slate-300">CloudGaming Hub</span> · multi-cloud gaming infrastructure
              </span>
              <span>
                AWS <span className="text-slate-700">/</span> Azure <span className="text-slate-700">/</span> GCP <span className="text-slate-700">/</span> Oracle
              </span>
              <span>© 2026 · NEON_CORE</span>
            </div>
          </footer>
        </div>
        </AuthProvider>
      </body>
    </html>
  );
}
