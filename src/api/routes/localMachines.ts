/**
 * ============================================================================
 * src/api/routes/localMachines.ts — YOUR OWN PCs (signed in)
 * ============================================================================
 *
 * Mounted at /api/local-machines behind authMiddleware.
 *
 *   GET    /                       my local machines (status as the agent last reported)
 *   POST   /                       add one  { name, lanIp?, mac? } → { machine, agentToken, installCommand }
 *   PATCH  /:id                    { name?, lanIp?, mac?, scriptEnabled?, displayMode? }
 *   DELETE /:id
 *   POST   /:id/token              new agent token (the old one stops) → { agentToken, installCommand }
 *   GET    /:id/launcher           what the generated Moonlight command needs → { launcherToken, lanIp, mac, api }
 *   POST   /:id/commands           { kind, args? } → { id, kind }   (the agent picks it up within seconds)
 *   GET    /:id/commands           the audit trail
 *   GET    /:id/commands/:cid      one command's progress
 *   POST   /:id/pair               Moonlight pairing → { commandId, pin, host }
 *   GET    /:id/reports            what the agent measured (?kind=diagnose|record|logs), newest first
 *   GET    /:id/reports/:rid       one report with its plain-English findings and a text version to paste
 *   GET    /:id/live?since=N       live samples while a recording runs
 *
 * The agent's own routes are public (token-checked) in localAgent.ts.
 * ============================================================================
 */

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { env } from '../../config/env';
import {
  listLocalMachines, createLocalMachine, updateLocalMachine, deleteLocalMachine, rotateAgentToken,
  launcherInfo, sendLocalCommand, getLocalCommand, recentLocalCommands, listReports, getReport, getLive,
} from '../../services/LocalMachineService';
import { sendRouteError } from './machines';

const router = Router();

/** This backend's public address including /api (what the agent and the Mac command call). */
export function publicApi(req: Request): string {
  if (env.API_PUBLIC_URL) return env.API_PUBLIC_URL;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
  return `${proto}://${req.get('host')}/api`;
}

/** Pasted once into an elevated PowerShell on the PC. */
function installCommand(api: string, token: string): string {
  return `& ([scriptblock]::Create((irm '${api}/local-agent/install.ps1'))) -Token '${token}' -Api '${api}'`;
}

const noStore = (res: Response) => res.set('Cache-Control', 'no-store');

router.get('/', async (req: Request, res: Response) => {
  try { noStore(res); res.json(await listLocalMachines(req.userId!)); } catch (e) { sendRouteError(res, e, 'Failed to list local machines'); }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    noStore(res);
    const { machine, agentToken } = await createLocalMachine(req.userId!, req.body || {});
    res.status(201).json({ machine, agentToken, installCommand: installCommand(publicApi(req), agentToken) });
  } catch (e) { sendRouteError(res, e, 'Failed to add the local machine'); }
});

router.patch('/:id', async (req: Request, res: Response) => {
  try { res.json(await updateLocalMachine(req.userId!, req.params.id, req.body || {})); } catch (e) { sendRouteError(res, e, 'Failed to update the local machine'); }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try { await deleteLocalMachine(req.userId!, req.params.id); res.json({ ok: true }); } catch (e) { sendRouteError(res, e, 'Failed to remove the local machine'); }
});

router.post('/:id/token', async (req: Request, res: Response) => {
  try {
    noStore(res);
    const agentToken = await rotateAgentToken(req.userId!, req.params.id);
    res.json({ agentToken, installCommand: installCommand(publicApi(req), agentToken) });
  } catch (e) { sendRouteError(res, e, 'Failed to make a new token'); }
});

router.get('/:id/launcher', async (req: Request, res: Response) => {
  try { noStore(res); res.json({ ...(await launcherInfo(req.userId!, req.params.id)), api: publicApi(req) }); } catch (e) { sendRouteError(res, e, 'Failed to read the launcher details'); }
});

router.post('/:id/commands', async (req: Request, res: Response) => {
  try { res.status(202).json(await sendLocalCommand(req.userId!, req.params.id, req.body?.kind, req.body?.args)); } catch (e) { sendRouteError(res, e, 'Failed to send the command'); }
});

router.get('/:id/commands', async (req: Request, res: Response) => {
  try { res.json(await recentLocalCommands(req.userId!, req.params.id, Number(req.query.limit) || 20)); } catch (e) { sendRouteError(res, e, 'Failed to read the command log'); }
});

router.get('/:id/commands/:cid', async (req: Request, res: Response) => {
  try { res.json(await getLocalCommand(req.userId!, req.params.id, req.params.cid)); } catch (e) { sendRouteError(res, e, 'Failed to read the command'); }
});

// Same idea as pairing a cloud machine: GGGH picks the PIN, you run
// `moonlight pair <ip> --pin <PIN>`, and the agent enters the PIN into Sunshine.
router.post('/:id/pair', async (req: Request, res: Response) => {
  try {
    const pin = String(crypto.randomInt(1000, 10000));
    const cmd = await sendLocalCommand(req.userId!, req.params.id, 'sunshine-pin', { pin, name: 'GGGH' });
    const info = await launcherInfo(req.userId!, req.params.id);
    res.status(202).json({ commandId: cmd.id, pin, host: info.lanIp });
  } catch (e) { sendRouteError(res, e, 'Failed to start pairing'); }
});

router.get('/:id/reports', async (req: Request, res: Response) => {
  try { res.json(await listReports(req.userId!, req.params.id, typeof req.query.kind === 'string' ? req.query.kind : undefined)); } catch (e) { sendRouteError(res, e, 'Failed to list the reports'); }
});

router.get('/:id/reports/:rid', async (req: Request, res: Response) => {
  try { noStore(res); res.json(await getReport(req.userId!, req.params.id, req.params.rid)); } catch (e) { sendRouteError(res, e, 'Failed to read the report'); }
});

router.get('/:id/live', async (req: Request, res: Response) => {
  try { noStore(res); res.json(await getLive(req.userId!, req.params.id, Number(req.query.since) || 0)); } catch (e) { sendRouteError(res, e, 'Failed to read the live data'); }
});

export default router;
