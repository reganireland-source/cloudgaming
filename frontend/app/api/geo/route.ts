/**
 * ============================================================================
 * frontend/app/api/geo/route.ts — "ROUGHLY WHERE IS THIS VISITOR?" (FROM THEIR IP)
 * ============================================================================
 *
 * GET /api/geo  (on the Vercel frontend, not the Railway backend)
 *
 * Vercel's edge network looks up every visitor's IP address in its own
 * geolocation database and attaches the result to the request as headers:
 *   x-vercel-ip-latitude, x-vercel-ip-longitude, x-vercel-ip-city,
 *   x-vercel-ip-country-region, x-vercel-ip-country
 * This route just reads those headers and returns them — no third-party
 * lookup service, and the IP address itself is never stored or passed on.
 *
 * Accuracy: usually the right city (it's where your internet provider's
 * network is registered), sometimes a nearby one; VPNs show the VPN's
 * location. Outside Vercel (e.g. local development) the headers don't
 * exist, so it answers { available: false }.
 * ============================================================================
 */

import { NextRequest, NextResponse } from 'next/server';

// Always run per request (the answer depends on who's asking).
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  const h = request.headers;
  const lat = parseFloat(h.get('x-vercel-ip-latitude') || '');
  const lng = parseFloat(h.get('x-vercel-ip-longitude') || '');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ available: false }, { headers: { 'Cache-Control': 'no-store' } });
  }
  // City names arrive URL-encoded (e.g. "S%C3%A3o%20Paulo").
  const decode = (v: string | null) => { try { return v ? decodeURIComponent(v) : null; } catch { return v; } };
  return NextResponse.json(
    {
      available: true,
      lat,
      lng,
      city: decode(h.get('x-vercel-ip-city')),
      region: decode(h.get('x-vercel-ip-country-region')),
      country: h.get('x-vercel-ip-country'),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
