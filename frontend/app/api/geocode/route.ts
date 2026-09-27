/**
 * ============================================================================
 * app/api/geocode/route.ts — TURN "Melbourne" OR "Australia" INTO LAT/LNG
 * ============================================================================
 *
 * GET /api/geocode?q=melbourne → { results: Place[], source }
 *
 * Used by the Recon page's location box. Countries and well-known cities
 * come from the built-in list (lib/places.ts), so the common cases answer
 * instantly and never depend on a third party. Anything else (small towns)
 * goes to Open-Meteo's free geocoder (no API key, no sign-up):
 * https://open-meteo.com/en/docs/geocoding-api. If that is unreachable, the
 * built-in matches are all you get — never an error.
 *
 * "Town, Country" / "Town, State" narrows the search (the geocoder only
 * matches the name, so the part after the comma is filtered here).
 * ============================================================================
 */

import { NextRequest, NextResponse } from 'next/server';
import { searchPlaces, type Place } from '@/lib/places';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const q = (request.nextUrl.searchParams.get('q') || '').trim().slice(0, 100);
  if (q.length < 2) return NextResponse.json({ results: [], source: 'none' });

  const builtIn = searchPlaces(q, 8);
  let remote: Place[] = [];
  let source = 'built-in';
  const [name, filter] = q.split(',').map((s) => s.trim().toLowerCase());
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), next: { revalidate: 86400 } });
    if (res.ok) {
      const data = await res.json();
      remote = (data.results || [])
        .filter((r: any) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude))
        .filter((r: any) => !filter || [r.country, r.country_code, r.admin1].some((f: string) => f && f.toLowerCase().startsWith(filter)))
        .map((r: any): Place => ({
          name: r.name, admin: r.admin1 || undefined, country: r.country || r.country_code, countryCode: r.country_code,
          lat: r.latitude, lng: r.longitude, kind: String(r.feature_code || '').startsWith('PCL') ? 'country' : 'city',
        }));
      source = 'open-meteo';
    }
  } catch {
    // Unreachable or slow: the built-in list still answers.
  }

  // Built-in first (countries map to their internet hub), then the geocoder's
  // extra towns; drop near-duplicates (same name within ~30 km).
  const results: Place[] = [];
  for (const p of [...builtIn, ...remote]) {
    const dup = results.some((r) => r.name.toLowerCase() === p.name.toLowerCase() && Math.abs(r.lat - p.lat) < 0.3 && Math.abs(r.lng - p.lng) < 0.3);
    if (!dup && !(p.kind === 'country' && results.some((r) => r.kind === 'country' && r.countryCode === p.countryCode))) results.push(p);
  }
  return NextResponse.json({ results: results.slice(0, 8), source });
}
