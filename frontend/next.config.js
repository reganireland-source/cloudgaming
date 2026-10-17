/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api',
  },
  // /rocjob: a plain static page (public/rocjob/), not part of the app — no
  // sign-in, no app layout. Its content comes from public/rocjob/page.txt.
  async rewrites() {
    return [{ source: '/rocjob', destination: '/rocjob/index.html' }];
  },
}

module.exports = nextConfig
