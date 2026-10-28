/**
 * ============================================================================
 * src/api/routes/scudrace.ts: LAP-TIME LEADERBOARD FOR THE SCUD RACE GAME (public routes)
 * ============================================================================
 *
 *   POST   /api/scudrace/scores        a lap (JSON, see docs/scudrace-leaderboard.md) → { rank, best_for_install, total_entries }
 *   GET    /api/scudrace/leaderboard   ?group=&mode=&course=&car=&transmission=&limit= → [{ rank, initials, lap_ms, car, ... }]
 *   GET    /api/scudrace/health        → { status: "ok" }
 *   DELETE /api/scudrace/scores        ?group=[&mode=&course=] with X-Scudrace-Admin → clears scores (owner only)
 *
 * There are no accounts: a group code (the friends' code, set in SCUDRACE_GROUPS)
 * is what lets a game post and read. Errors: 400 invalid, 403 unknown group,
 * 429 slow down, 503 not switched on.
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { adminOk, allow, board, clear, CARS, COURSES, enabled, groupFull, knownGroup, MODES, parseScore, submit, TRANSMISSIONS } from '../../services/ScudraceBoard';

const router = Router();

router.get('/health', (_req: Request, res: Response) => { res.set('Cache-Control', 'no-store').json({ status: 'ok', enabled: enabled(), time: new Date().toISOString() }); });

router.post('/scores', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  if (!enabled()) return res.status(503).json({ error: 'Not switched on.' });
  if (!allow(`ip:${req.ip}`, 120, 60_000)) return res.status(429).set('Retry-After', '60').json({ error: 'Slow down.' });
  const p = parseScore(req.body);
  if (!p.ok) return res.status(p.error === 'Unknown group code.' ? 403 : 400).json({ error: p.error });
  if (!allow(`id:${p.score.install}`, 120, 3600_000)) return res.status(429).set('Retry-After', '600').json({ error: 'Too many laps from this install. Try again later.' });
  try {
    if (await groupFull(p.score.grp)) return res.status(429).set('Retry-After', '3600').json({ error: 'This group has reached its daily limit.' });
    res.json(await submit(p.score));
  } catch (e) { console.error('scudrace submit failed:', (e as Error).message); res.status(500).json({ error: 'Try again shortly.' }); }
});

router.get('/leaderboard', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  if (!enabled()) return res.status(503).json({ error: 'Not switched on.' });
  if (!allow(`rd:${req.ip}`, 120, 60_000)) return res.status(429).set('Retry-After', '60').json({ error: 'Slow down.' });
  const grp = knownGroup(req.query.group);
  if (!grp) return res.status(403).json({ error: 'Unknown group code.' });
  const mode = String(req.query.mode || ''), course = String(req.query.course || '');
  if (!(MODES as readonly string[]).includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}.` });
  if (!(COURSES as readonly string[]).includes(course)) return res.status(400).json({ error: `course must be one of ${COURSES.join(', ')}.` });
  const car = req.query.car === undefined || req.query.car === '' ? undefined : String(req.query.car);
  if (car && !(CARS as readonly string[]).includes(car)) return res.status(400).json({ error: `car must be one of ${CARS.join(', ')}.` });
  const transmission = req.query.transmission === undefined || req.query.transmission === '' ? undefined : String(req.query.transmission);
  if (transmission && !(TRANSMISSIONS as readonly string[]).includes(transmission)) return res.status(400).json({ error: 'transmission must be auto or manual.' });
  const limit = Math.min(Math.max(Math.round(Number(req.query.limit)) || 50, 1), 200);
  try { res.json(await board({ grp, mode, course, car, transmission, limit })); } catch (e) { console.error('scudrace board failed:', (e as Error).message); res.status(500).json({ error: 'Try again shortly.' }); }
});

router.delete('/scores', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  if (!process.env.SCUDRACE_ADMIN_TOKEN) return res.status(404).json({ error: 'Not found.' });
  if (!allow(`adm:${req.ip}`, 20, 60_000)) return res.status(429).json({ error: 'Slow down.' });
  if (!adminOk(req.headers['x-scudrace-admin'])) return res.status(401).json({ error: 'Wrong token.' });
  const grp = knownGroup(req.query.group);
  if (!grp) return res.status(400).json({ error: 'Name a known group.' });
  const mode = req.query.mode ? String(req.query.mode) : undefined, course = req.query.course ? String(req.query.course) : undefined;
  try { res.json({ deleted: await clear(grp, mode, course) }); } catch (e) { console.error('scudrace clear failed:', (e as Error).message); res.status(500).json({ error: 'Try again shortly.' }); }
});

export default router;
