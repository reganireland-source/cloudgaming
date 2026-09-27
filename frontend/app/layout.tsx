import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CloudGaming Hub",
  description: "Multi-cloud gaming infrastructure platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="flex flex-col min-h-screen bg-gray-50">
          <nav className="bg-white shadow">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="flex justify-between h-16">
                <div className="flex items-center">
                  <h1 className="text-2xl font-bold text-blue-600">CloudGaming Hub</h1>
                </div>
                <div className="flex items-center space-x-4">
                  <a href="/" className="text-gray-600 hover:text-gray-900">Dashboard</a>
                  <a href="/machines" className="text-gray-600 hover:text-gray-900">Machines</a>
                  <a href="/recommendations" className="text-gray-600 hover:text-gray-900">Recommendations</a>
                  <a href="/costs" className="text-gray-600 hover:text-gray-900">Costs</a>
                </div>
              </div>
            </div>
          </nav>
          <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
            {children}
          </main>
          <footer className="bg-white border-t mt-12">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 text-center text-gray-600 text-sm">
              <p>&copy; 2026 CloudGaming Hub. Multi-cloud gaming infrastructure made simple.</p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
