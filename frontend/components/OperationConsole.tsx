'use client';

/**
 * ============================================================================
 * frontend/components/OperationConsole.tsx — LIVE COMMENTARY FOR A CLOUD ACTION
 * ============================================================================
 *
 * Every cloud action (launch, start, stop, delete, sync) runs in the
 * background on the backend as an OPERATION, which writes short log lines as
 * it goes (backend: src/services/OperationLog.ts). This component shows
 * those lines live, like a terminal:
 *
 *   14:02:11  ·  Launch T4 · 4 vCPU on Google Cloud in Singapore
 *   14:02:12  ·  Loading your encrypted cloud credentials…
 *   14:02:13  ·  Trying zone asia-southeast1-a…
 *   14:02:20  ⚠  asia-southeast1-a: no spare GPUs right now — trying the next zone.
 *   14:02:41  ✓  Machine cg-3f1c9e2a created in asia-southeast1-b with public IP 34.1.2.3
 *
 * HOW: it polls GET /api/operations/:id?after=<last line id> every ~1.2 s,
 * appending only NEW lines, until the operation is 'succeeded' or 'failed'.
 * On failure it shows the plain-English error card with the fix.
 *
 * React ideas used: useEffect with a cleanup function (stops polling when
 * the component disappears), useRef (remembers the last line id between
 * polls without causing re-renders), and auto-scrolling a div to the bottom.
 * ============================================================================
 */

import { useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError, type FriendlyError } from '@/lib/auth';
import FriendlyErrorCard from './FriendlyErrorCard';

interface OpEvent {
  id: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  detail?: string | null;
  created_at: string;
}

export interface OperationState {
  id: string;
  title: string;
  status: 'running' | 'succeeded' | 'failed';
  error?: FriendlyError | null;
  result?: any;
  machine_id?: string | null;
  events: OpEvent[];
}

const ICON: Record<OpEvent['level'], string> = { info: '·', success: '✓', warn: '⚠', error: '✗' };
const COLOUR: Record<OpEvent['level'], string> = {
  info: 'text-slate-300',
  success: 'text-neon-lime',
  warn: 'text-neon-amber',
  error: 'text-neon-pink',
};

export default function OperationConsole({
  operationId,
  onFinished,
  height = 'max-h-72',
}: {
  operationId: string;
  /** Called once when the operation ends (e.g. to refresh the machine list). */
  onFinished?: (op: OperationState) => void;
  height?: string;
}) {
  const [op, setOp] = useState<OperationState | null>(null);
  const [events, setEvents] = useState<OpEvent[]>([]);
  const [pollError, setPollError] = useState<string | null>(null);
  const lastId = useRef(0);          // id of the newest line we have
  const finishedRef = useRef(false); // so onFinished fires only once
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    lastId.current = 0;
    finishedRef.current = false;
    setEvents([]);
    setOp(null);

    const poll = async () => {
      try {
        const data = await apiFetch<OperationState>(`/operations/${operationId}?after=${lastId.current}`);
        if (cancelled) return;
        setPollError(null);
        if (data.events.length) {
          lastId.current = data.events[data.events.length - 1].id;
          setEvents((prev) => [...prev, ...data.events]);
        }
        setOp(data);
        if (data.status !== 'running') {
          if (!finishedRef.current) {
            finishedRef.current = true;
            onFinished?.(data);
          }
          return; // stop polling
        }
      } catch (error) {
        if (cancelled) return;
        // Keep trying: a blip (backend redeploying) shouldn't lose the log.
        setPollError(error instanceof ApiError ? `${error.message}${error.tip ? ` — ${error.tip}` : ''}` : 'Lost contact with the backend; retrying…');
      }
      timer = setTimeout(poll, 1200);
    };
    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // onFinished is deliberately not a dependency: a new function each render
    // would restart polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operationId]);

  // Keep the newest line in view.
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [events.length]);

  const running = !op || op.status === 'running';

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-white/10 bg-black/40">
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
          <span className="label">Live log</span>
          <span className={`text-[0.68rem] uppercase tracking-label ${
            running ? 'text-neon-cyan' : op?.status === 'succeeded' ? 'text-neon-lime' : 'text-neon-pink'
          }`}>
            {running ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-neon-cyan animate-pulse" /> working
              </span>
            ) : op?.status === 'succeeded' ? '✓ done' : '✗ failed'}
          </span>
        </div>
        <div ref={scroller} className={`${height} overflow-y-auto px-3 py-2 font-mono text-[0.74rem] leading-relaxed`}>
          {events.length === 0 && <p className="text-slate-500">&gt; waiting for the first update…</p>}
          {events.map((e) => (
            <div key={e.id} className="flex gap-3">
              <span className="text-slate-600 tabular-nums flex-shrink-0">
                {new Date(e.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span className={`${COLOUR[e.level]} flex-shrink-0 w-3 text-center`}>{ICON[e.level]}</span>
              <span className={COLOUR[e.level]}>
                {e.message}
                {e.detail && e.level !== 'info' && (
                  <span className="block text-slate-500 text-[0.68rem] break-all">{e.detail}</span>
                )}
              </span>
            </div>
          ))}
          {running && events.length > 0 && <p className="text-slate-600 animate-pulse">▌</p>}
        </div>
      </div>
      {pollError && <p className="text-xs text-neon-amber">⚠ {pollError}</p>}
      {op?.status === 'failed' && <FriendlyErrorCard friendly={op.error} />}
    </div>
  );
}
