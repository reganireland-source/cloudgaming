/**
 * ============================================================================
 * src/api/routes/rocjob.ts: ANONYMOUS PLAY STATS FOR THE ROCJOB GAME (public routes)
 * ============================================================================
 *
 *   POST   /api/rocjob/event   header X-Rocjob-Key; JSON ≤ 1 KB (see services/RocjobStats.ts) → 204
 *   GET    /api/rocjob/stats   header X-Rocjob-Stats-Token (or Authorization: Bearer) → numbers for the private page
 *   DELETE /api/rocjob/data    same token + body { "confirm": "WIPE" } → deletes all stats
 *
 * Responses: 204 fast on success; 400 invalid input; 401 wrong key/token;
 * 429 slow down; 503 not switched on (settings missing). No address, user
 * agent or other identifier is ever stored or logged here.
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { allow, ingestEnabled, ingestKeyOk, parseEvent, recordEvent, stats, statsEnabled, statsTokenOk, wipe } from '../../services/RocjobStats';

const router = Router();
const bearer = (req: Request) => String(req.headers['x-rocjob-stats-token'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || '').trim();

router.post('/event', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  if (!ingestEnabled()) return res.status(503).json({ error: 'Not switched on.' });
  // Per visitor, in memory for a minute only (never written anywhere).
  if (!allow(`ip:${req.ip}`, 60, 60_000)) return res.status(429).set('Retry-After', '60').json({ error: 'Slow down.' });
  if (!ingestKeyOk(req.headers['x-rocjob-key'])) return res.status(401).json({ error: 'Bad key.' });
  const e = parseEvent(req.body);
  if (!e) return res.status(400).json({ error: 'Invalid event.' });
  if (!allow(`id:${e.install}`, 240, 3600_000)) return res.status(429).set('Retry-After', '600').json({ error: 'Slow down.' });
  try { await recordEvent(e); res.status(204).end(); } catch (err) { console.error('rocjob event failed:', (err as Error).message); res.status(500).json({ error: 'Try again shortly.' }); }
});

function guard(req: Request, res: Response): boolean {
  res.set('Cache-Control', 'no-store');
  if (!statsEnabled()) { res.status(404).json({ error: 'Not found.' }); return false; }
  if (!allow(`stats:${req.ip}`, 30, 60_000)) { res.status(429).json({ error: 'Slow down.' }); return false; }
  if (!statsTokenOk(bearer(req))) { res.status(401).json({ error: 'Wrong token.' }); return false; }
  return true;
}

router.get('/stats', async (req: Request, res: Response) => {
  if (!guard(req, res)) return;
  try { res.json(await stats()); } catch (e) { console.error('rocjob stats failed:', (e as Error).message); res.status(500).json({ error: 'Try again shortly.' }); }
});

router.delete('/data', async (req: Request, res: Response) => {
  if (!guard(req, res)) return;
  if (req.body?.confirm !== 'WIPE') return res.status(400).json({ error: 'Send {"confirm":"WIPE"} to delete everything.' });
  try { await wipe(); res.json({ ok: true }); } catch (e) { console.error('rocjob wipe failed:', (e as Error).message); res.status(500).json({ error: 'Try again shortly.' }); }
});

export default router;
