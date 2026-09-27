import type { Metadata } from "next";
import "./globals.css";
import SystemStatusBar from "@/components/SystemStatusBar";
import NavLinks from "@/components/NavLinks";

export const metadata: Metadata = {
  title: "CloudGaming Hub",
  description: "Multi-cloud gaming infrastructure — cost, latency and performance across AWS, Azure, GCP and Oracle",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-cyber-dark">
        <div className="flex flex-col min-h-screen">
          <nav className="sticky top-0 z-50 border-b border-white/[0.06] bg-cyber-darker/95 backdrop-blur-md">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="flex justify-between items-center h-12 gap-6">
                <a href="/" className="flex items-center gap-3 flex-shrink-0">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-sm border border-neon-cyan/40 bg-neon-cyan/[0.06] text-neon-cyan text-[0.7rem] shadow-[0_0_10px_-2px_rgba(95,215,224,0.5)]">
                    ▲
                  </span>
                  <span className="text-[0.85rem] font-semibold tracking-[0.14em] text-slate-100">
                    CLOUDGAMING<span className="text-neon-cyan">/</span>HUB
                  </span>
                  <span className="hidden md:inline-block text-[0.62rem] tracking-label text-slate-500 border border-white/10 rounded-sm px-1.5 py-px">
                    NEON_CORE v0.1
                  </span>
                </a>
                <NavLinks />
              </div>
            </div>
          </nav>

          <SystemStatusBar />

          <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
            {children}
          </main>

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
      </body>
    </html>
  );
}
