/**
 * lib/myPlace.ts — WHERE IS THE PLAYER? (for "nearest first" lists)
 *
 * Uses the place saved by Recon / Regions ("recon.place"); failing that, a
 * quiet guess from the internet connection (/api/geo, no permission prompt).
 * Null until known, or if neither is available.
 */

import { useEffect, useState } from 'react';

export interface MyPlace { lat: number; lng: number; label: string }

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
}
/** Same rough estimate as Recon and the map. */
export const pingFromKm = (km: number) => Math.round(5 + km * 0.015);

export function useMyPlace(): MyPlace | null {
  const [place, setPlace] = useState<MyPlace | null>(null);
  useEffect(() => {
    try {
      const s = localStorage.getItem('recon.place');
      if (s) {
        const p = JSON.parse(s);
        if (Number.isFinite(p?.lat) && Number.isFinite(p?.lng)) { setPlace({ lat: p.lat, lng: p.lng, label: p.label || 'you' }); return; }
      }
    } catch { /* ignore */ }
    let live = true;
    fetch('/api/geo').then((r) => r.json()).then((g) => {
      if (live && g?.available) setPlace({ lat: g.lat, lng: g.lng, label: [g.city, g.country].filter(Boolean).join(', ') || 'your connection' });
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  return place;
}

/** Regions nearest-first, each with its estimated ping (unsorted if we don't know where you are). */
export function byDistance<T extends { lat?: number; lng?: number }>(regions: T[], place: MyPlace | null): Array<T & { pingMs: number | null }> {
  const withPing = regions.map((r) => ({
    ...r,
    pingMs: place && Number.isFinite(r.lat) && Number.isFinite(r.lng) ? pingFromKm(distanceKm(place, { lat: r.lat!, lng: r.lng! })) : null,
  }));
  return place ? withPing.sort((a, b) => (a.pingMs ?? 1e9) - (b.pingMs ?? 1e9)) : withPing;
}
