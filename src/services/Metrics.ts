/**
 * ============================================================================
 * src/services/Metrics.ts — HOW BUSY IS THE BACKEND?
 * ============================================================================
 *
 * A tiny in-memory counter of the HTTP requests this server has answered,
 * fed by the request-logging middleware in src/index.ts. The BACKEND status
 * light's detail panel shows these numbers, so you can see the server is
 * genuinely doing work (and how fast).
 *
 * In memory only: it resets whenever the server restarts (e.g. a new deploy
 * on Railway), which the panel makes clear via "since start".
 * ============================================================================
 */

interface MinuteBucket { minute: number; requests: number; errors: number }

const totals = { requests: 0, errors4xx: 0, errors5xx: 0, totalMs: 0 };
const slowest: Array<{ path: string; ms: number; at: string }> = [];
// One bucket per minute for the last hour, for the little requests chart.
const buckets: MinuteBucket[] = [];

/** Record one finished request (called from the middleware in index.ts). */
export function recordRequest(method: string, path: string, status: number, ms: number): void {
  totals.requests++;
  totals.totalMs += ms;
  if (status >= 500) totals.errors5xx++;
  else if (status >= 400) totals.errors4xx++;

  const minute = Math.floor(Date.now() / 60000);
  let bucket = buckets[buckets.length - 1];
  if (!bucket || bucket.minute !== minute) {
    bucket = { minute, requests: 0, errors: 0 };
    buckets.push(bucket);
    while (buckets.length > 60) buckets.shift();
  }
  bucket.requests++;
  if (status >= 500) bucket.errors++;

  // Keep the 5 slowest requests (ids in paths are shortened so nothing
  // user-specific is exposed on the public status panel).
  const cleanPath = `${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')}`;
  slowest.push({ path: cleanPath, ms, at: new Date().toISOString() });
  slowest.sort((a, b) => b.ms - a.ms);
  if (slowest.length > 5) slowest.length = 5;
}

export function getMetrics() {
  const nowMinute = Math.floor(Date.now() / 60000);
  // Fill gaps so the chart always has 30 evenly spaced minutes.
  const perMinute = Array.from({ length: 30 }, (_, i) => {
    const minute = nowMinute - 29 + i;
    const b = buckets.find((x) => x.minute === minute);
    return { minute: new Date(minute * 60000).toISOString(), requests: b?.requests || 0, errors: b?.errors || 0 };
  });
  return {
    requests: totals.requests,
    errors4xx: totals.errors4xx,
    errors5xx: totals.errors5xx,
    avgResponseMs: totals.requests ? Math.round(totals.totalMs / totals.requests) : null,
    requestsLastMinute: perMinute[perMinute.length - 1].requests,
    perMinute,
    slowest: [...slowest],
  };
}
