/**
 * ============================================================================
 * frontend/lib/api.ts — WHERE THE BACKEND LIVES
 * ============================================================================
 *
 * The app is split in two, hosted separately:
 *   - FRONTEND (this Next.js project) on Vercel — what runs in your browser
 *   - BACKEND  (the Express server in ../src)  on Railway — the data & logic
 * So when a page wants data, it must call the backend's full web address,
 * e.g. https://your-app.up.railway.app/api/status.
 *
 * A bare fetch('/api/status') would NOT work: a path starting with "/" goes
 * to the site the page came from — the Vercel frontend — which doesn't have
 * those routes, so it would get a 404.
 *
 * WHERE THE ADDRESS COMES FROM
 * ----------------------------
 * The environment variable NEXT_PUBLIC_API_URL, set in Vercel's settings,
 * e.g. "https://your-app.up.railway.app/api" (note: it includes /api).
 * Next.js only exposes variables starting with NEXT_PUBLIC_ to browser code,
 * and it BAKES the value into the code at build time — so after changing it
 * in Vercel you must redeploy for it to take effect.
 * Locally, it falls back to http://localhost:3001/api.
 * ============================================================================
 */

// The backend is a separately-hosted service (Railway), not a Next.js API
// route, so every call needs the full base URL - a bare fetch('/api/...')
// would hit the Next.js server itself and 404.
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

/**
 * Build a full backend URL from a path.
 * Usage:  fetch(apiUrl('/status'))  ->  fetch('https://...railway.app/api/status')
 * Accepts the path with or without its leading slash ('status' works too).
 */
export function apiUrl(path: string): string {
  // Ensure exactly one "/" between the base and the path.
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${cleanPath}`;
}
