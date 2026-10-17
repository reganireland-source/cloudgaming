/**
 * ============================================================================
 * src/api/routes/localAgent.ts — THE PC'S AGENT AND THE MOONLIGHT COMMAND
 * ============================================================================
 *
 * PUBLIC routes (no sign-in) that check a Bearer token instead. Mounted at
 * /api/local-agent:
 *
 *   GET  /install.ps1   the installer (no secrets in it; the token is passed on its command line)
 *   GET  /agent.ps1     the agent (it fetches newer copies of itself from here, checked against a SHA-256 GGGH sends)
 *   GET  /boot.ps1      the small wrapper that keeps the agent running and rolls a bad update back
 *   POST /heartbeat     agent: "still here" during long jobs
 *   POST /report        agent: { commandId, kind, data } what it measured
 *   POST /live          agent: { samples: [...] } during a recording
 *   POST /poll          agent: "here is my status; any work?" — waits up to ~25 s → { commands, pollSeconds }
 *   POST /result        agent: { id, ok, message }
 *   POST /screen        generated Moonlight command (launcher token): { action: 'set'|'restore', width?, height?, fps? }
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { agentPoll, agentResult, launcherScreen, agentHeartbeat, agentReport, agentLive } from '../../services/LocalMachineService';
import { AGENT_PS1, BOOT_PS1, INSTALL_PS1 } from '../../providers/shared/localAgent';

const router = Router();
const bearer = (req: Request) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

router.get('/install.ps1', (_req, res) => { res.type('text/plain').send(INSTALL_PS1); });
router.get('/agent.ps1', (_req, res) => { res.type('text/plain').send(AGENT_PS1); });
router.get('/boot.ps1', (_req, res) => { res.type('text/plain').send(BOOT_PS1); });

router.post('/poll', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const out = await agentPoll(bearer(req), req.body);
    if (!out) return res.status(401).json({ error: 'Unknown token. Run the install command from GGGH again.' });
    res.json(out);
  } catch (e) {
    console.error('local-agent poll:', e);
    res.status(500).json({ error: 'Try again shortly.' });
  }
});

router.post('/result', async (req: Request, res: Response) => {
  try {
    const ok = await agentResult(bearer(req), String(req.body?.id || ''), req.body?.ok === true, req.body?.message);
    res.status(ok ? 200 : 404).json({ ok });
  } catch (e) {
    console.error('local-agent result:', e);
    res.status(500).json({ error: 'Try again shortly.' });
  }
});

router.post('/heartbeat', async (req: Request, res: Response) => {
  try { res.status((await agentHeartbeat(bearer(req))) ? 200 : 401).json({ ok: true }); } catch { res.status(500).json({ error: 'Try again shortly.' }); }
});

router.post('/report', async (req: Request, res: Response) => {
  try {
    const id = await agentReport(bearer(req), String(req.body?.commandId || ''), String(req.body?.kind || ''), req.body?.data);
    res.status(id ? 200 : 400).json(id ? { id } : { error: 'Report refused (unknown command, kind, or too large).' });
  } catch (e) { console.error('local-agent report:', e); res.status(500).json({ error: 'Try again shortly.' }); }
});

router.post('/live', async (req: Request, res: Response) => {
  try { res.status((await agentLive(bearer(req), req.body?.samples)) ? 200 : 401).json({ ok: true }); } catch { res.status(500).json({ error: 'Try again shortly.' }); }
});

router.post('/screen', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const action = req.body?.action === 'restore' ? 'restore' : req.body?.action === 'set' ? 'set' : null;
    if (!action) return res.status(400).json({ error: 'action must be "set" or "restore".' });
    const out = await launcherScreen(bearer(req), action, req.body || {}, action === 'set' ? 25_000 : 8_000);
    if (!out) return res.status(401).json({ error: 'Unknown token.' });
    res.json(out);
  } catch (e) {
    const msg = (e as any)?.status ? (e as Error).message : 'Try again shortly.';
    res.status((e as any)?.status || 500).json({ error: msg });
  }
});

export default router;
