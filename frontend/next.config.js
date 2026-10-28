/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api',
  },
  // /rocjob: a plain static page (public/rocjob/), not part of the app — no
  // sign-in, no app layout. Its content comes from public/rocjob/page.txt.
  async rewrites() {
    return [
      { source: '/rocjob', destination: '/rocjob/index.html' },
      // The stats page under the game's player-facing name; /rocjob-stats keeps working (same page).
      { source: '/facemelters-stats', destination: '/rocjob-stats/index.html' },
      { source: '/rocjob-stats', destination: '/rocjob-stats/index.html' },
      // The Scud Race lap-time leaderboard page (public/scudrace/).
      { source: '/scudrace', destination: '/scudrace/index.html' },
      // The game page under its player-facing name; /rocjob keeps working (same page).
      { source: '/facemelters', destination: '/rocjob/index.html' },
    ];
  },
  // /rocjob/get/windows and /rocjob/get/mac: short download links on this site that
  // lead to the "latest" zips in Vercel Blob (the same files page.txt links to).
  async redirects() {
    const blob = 'https://stxqpdyndd3dc0mg.public.blob.vercel-storage.com/rocjob/download';
    return [
      { source: '/rocjob/get/windows', destination: `${blob}/Rocjob-Windows-latest.zip`, permanent: false },
      { source: '/rocjob/get/mac', destination: `${blob}/Rocjob-Mac-latest.zip`, permanent: false },
    ];
  },
}

module.exports = nextConfig
