import type { Metadata } from "next";
import "./globals.css";
import SystemStatusBar from "@/components/SystemStatusBar";

export const metadata: Metadata = {
  title: "CloudGaming Hub | Neon Core",
  description: "Multi-cloud gaming infrastructure platform — 90s hacker aesthetic",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-cyber-dark text-neon-cyan">
        <div className="flex flex-col min-h-screen">
          {/* Navbar with neon aesthetic */}
          <nav className="border-b-2 border-neon-cyan bg-gradient-to-r from-cyber-dark to-cyber-darker backdrop-blur-sm sticky top-0 z-50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="flex justify-between items-center h-20">
                <div className="flex items-center gap-2">
                  <div className="text-3xl font-bold">
                    <span className="neon-text">▲</span>
                    <span className="text-neon-magenta ml-2">CLOUDGAMING</span>
                    <span className="neon-accent"> HUB</span>
                  </div>
                  <div className="hidden sm:block ml-6 h-8 w-px bg-gradient-to-b from-neon-cyan to-transparent"></div>
                  <span className="hidden sm:inline text-xs text-neon-lime ml-6 font-mono animate-pulse">NEON_CORE_v1.0</span>
                </div>
                <div className="flex items-center space-x-1 sm:space-x-4 text-sm sm:text-base">
                  <a href="/" className="px-3 py-2 rounded border border-transparent hover:border-neon-cyan hover:text-neon-cyan transition-all duration-300 font-mono">
                    [DASH]
                  </a>
                  <a href="/machines" className="px-3 py-2 rounded border border-transparent hover:border-neon-magenta hover:text-neon-magenta transition-all duration-300 font-mono">
                    [VMS]
                  </a>
                  <a href="/performance" className="px-3 py-2 rounded border border-transparent hover:border-neon-lime hover:text-neon-lime transition-all duration-300 font-mono">
                    [PERF]
                  </a>
                  <a href="/recommendations" className="px-3 py-2 rounded border border-transparent hover:border-neon-pink hover:text-neon-pink transition-all duration-300 font-mono hidden md:inline-block">
                    [RECON]
                  </a>
                  <a href="/costs" className="px-3 py-2 rounded border border-transparent hover:border-neon-cyan hover:text-neon-cyan transition-all duration-300 font-mono hidden lg:inline-block">
                    [COSTS]
                  </a>
                  <a href="/settings" className="px-3 py-2 rounded border border-neon-magenta text-neon-magenta hover:bg-magenta-950/20 transition-all duration-300 font-mono">
                    [CFG]
                  </a>
                </div>
              </div>
            </div>
          </nav>

          <SystemStatusBar />

          {/* Main content area with grid background */}
          <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
            <div className="absolute inset-0 -z-10 opacity-[0.03] pointer-events-none" style={{
              backgroundImage: 'radial-gradient(circle, #00ffff 1px, transparent 1px)',
              backgroundSize: '40px 40px',
            }}></div>
            {children}
          </main>

          {/* Footer with neon styling */}
          <footer className="border-t-2 border-neon-cyan mt-12 bg-gradient-to-r from-cyber-darker to-cyber-dark backdrop-blur-sm">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                <div className="text-center md:text-left">
                  <p className="font-mono text-sm text-neon-cyan">
                    <span className="font-bold">CLOUDGAMING HUB</span>
                  </p>
                  <p className="font-mono text-xs text-neon-lime mt-1">Multi-cloud infrastructure</p>
                </div>
                <div className="text-center">
                  <p className="font-mono text-xs text-neon-magenta">
                    AWS • AZURE • GCP • ORACLE
                  </p>
                </div>
                <div className="text-center md:text-right">
                  <p className="font-mono text-xs text-neon-cyan">
                    © 2026 • NEON_CORE_v1.0
                  </p>
                </div>
              </div>
              <div className="border-t border-neon-cyan/20 pt-6">
                <p className="text-center font-mono text-xs text-neon-cyan/70">
                  Gaming infrastructure optimized for cost, latency, and performance
                </p>
              </div>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
