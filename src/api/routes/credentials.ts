/**
 * ============================================================================
 * src/api/routes/credentials.ts — ADD / CHECK / REMOVE YOUR CLOUD KEYS
 * ============================================================================
 *
 * Mounted at /api/credentials behind authMiddleware. Each user manages ONLY
 * their own keys; the backend never holds anyone else's.
 *
 *   GET    /api/credentials                    status of each cloud (NO secrets)
 *   GET    /api/credentials/forms              the fields each cloud's form needs
 *   POST   /api/credentials/:provider/check    test values WITHOUT saving
 *   PUT    /api/credentials/:provider          test, then save encrypted (only if no check fails)
 *   POST   /api/credentials/:provider/recheck  re-test the saved keys
 *   DELETE /api/credentials/:provider          remove them (?force=true if machines exist)
 *
 * Every check/save replies with a CHECKLIST — each item passed, warned or
 * failed, with a tip — so the Config page can show exactly what's wrong
 * and how to fix it.
 *
 * SECURITY
 * --------
 * - Values are encrypted by CredentialService before storage (AES-256-GCM).
 * - Nothing secret is ever sent back — only a metadata summary
 *   (e.g. project id, service account email, key id prefix).
 * - Checks make live calls to the cloud with the user's keys, so they're
 *   rate-limited per user (10 per minute) to prevent abuse.
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { query } from '../../config/database';
import { SETUP_MODULES, isProviderName } from '../../providers/registry';
import { ProviderName } from '../../providers/shared/types';
import { FriendlyCloudError, toFriendlyError } from '../../providers/errors';
import {
  PROVIDER_LABELS,
  decryptCredentials,
  deleteCredentials,
  encryptionReady,
  listCredentialSummaries,
  recordCheck,
  saveCredentials,
} from '../../services/CredentialService';

const router = Router();

// ---- simple per-user rate limit for live checks ---------------------------
const checkTimes = new Map<string, number[]>();
function allowCheck(userId: string): boolean {
  const now = Date.now();
  const recent = (checkTimes.get(userId) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 10) return false;
  recent.push(now);
  checkTimes.set(userId, recent);
  return true;
}

function badProvider(res: Response, value: string) {
  return res.status(404).json({ error: `Unknown cloud "${value}".`, tip: 'Use gcp, aws, azure or oracle.' });
}

/** Keep only the fields this cloud's form defines, as trimmed strings. */
function cleanInput(provider: ProviderName, body: any): Record<string, string> {
  const input: Record<string, string> = {};
  for (const field of SETUP_MODULES[provider].fields) {
    const raw = body?.[field.key];
    if (raw === undefined || raw === null) continue;
    // Keys pasted as objects (e.g. parsed JSON) are turned back into text.
    input[field.key] = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
  }
  return input;
}

/** Required fields that are empty → a 'fail' checklist, without calling the cloud. */
function missingRequired(provider: ProviderName, input: Record<string, string>) {
  return SETUP_MODULES[provider].fields
    .filter((f) => f.required && !input[f.key])
    .map((f) => ({ id: `missing-${f.key}`, label: f.label, status: 'fail' as const, message: `${f.label} is required.`, tip: f.help }));
}

async function runChecks(provider: ProviderName, input: Record<string, string>, region?: string) {
  const missing = missingRequired(provider, input);
  if (missing.length) {
    return { ok: false, checks: missing, summary: `${missing.length} required field${missing.length === 1 ? '' : 's'} missing`, metadata: {} };
  }
  try {
    const result = await SETUP_MODULES[provider].runChecks(input, { region });
    return result;
  } catch (error) {
    // Setup modules shouldn't throw, but if one does, report it as a failed check.
    const f = toFriendlyError(error, provider);
    return {
      ok: false,
      checks: [{ id: 'unexpected', label: 'Checking your keys', status: 'fail' as const, message: f.title, tip: f.fixes.join(' '), consoleUrl: f.consoleUrl, consoleLabel: f.consoleLabel }],
      summary: '1 failed',
      metadata: {},
    };
  }
}

/** GET /api/credentials — which clouds are set up (no secrets). */
router.get('/', async (req: Request, res: Response) => {
  try {
    const saved = await listCredentialSummaries(req.userId!);
    res.json({
      encryptionReady: encryptionReady(),
      providers: (Object.keys(SETUP_MODULES) as ProviderName[]).map((p) => ({
        provider: p,
        label: PROVIDER_LABELS[p],
        saved: saved.find((s) => s.provider === p) || null,
      })),
    });
  } catch (error) {
    console.error('List credentials error:', error);
    res.status(500).json({ error: 'Failed to load your cloud keys', tip: 'Try again in a moment.' });
  }
});

/** GET /api/credentials/forms — the fields and intro text for each cloud's form. */
/**
 * GET/PUT /api/credentials/quota-contact — optional contact email for quota
 * requests (Google's command needs one). Filled into the ready-to-paste
 * commands so they run as-is. Empty = use the sign-in email.
 */
router.get('/quota-contact', async (req: Request, res: Response) => {
  try {
    const r = await query('SELECT email, quota_email FROM users WHERE id = $1', [req.userId]);
    res.json({ email: r.rows[0]?.quota_email || null, accountEmail: r.rows[0]?.email || null });
  } catch (error) {
    console.error('Quota contact error:', (error as Error).message);
    res.status(500).json({ error: 'Could not load the quota contact email' });
  }
});
router.put('/quota-contact', async (req: Request, res: Response) => {
  const raw = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (raw && (raw.length > 254 || !/^[^\s@"'`$;]+@[^\s@"'`$;]+\.[^\s@"'`$;]+$/.test(raw))) {
    return res.status(400).json({ error: 'That doesn’t look like an email address.', tip: 'Use the form name@example.com, or leave it empty to use your sign-in email.' });
  }
  try {
    await query('UPDATE users SET quota_email = $2 WHERE id = $1', [req.userId, raw || null]);
    res.json({ email: raw || null });
  } catch (error) {
    console.error('Quota contact save error:', (error as Error).message);
    res.status(500).json({ error: 'Could not save the quota contact email' });
  }
});

router.get('/forms', (_req: Request, res: Response) => {
  res.json(Object.fromEntries((Object.keys(SETUP_MODULES) as ProviderName[]).map((p) => [
    p, { label: PROVIDER_LABELS[p], intro: SETUP_MODULES[p].intro, fields: SETUP_MODULES[p].fields },
  ])));
});

/** POST /api/credentials/:provider/check — dry run, nothing saved. */
router.post('/:provider/check', async (req: Request, res: Response) => {
  const provider = req.params.provider;
  if (!isProviderName(provider)) return badProvider(res, provider);
  if (!allowCheck(req.userId!)) {
    return res.status(429).json({ error: 'Too many checks in a minute.', tip: 'Wait a moment and try again.' });
  }
  const result = await runChecks(provider, cleanInput(provider, req.body), req.body?.region);
  const { secret: _secret, ...safe } = result as any; // never send the secret back
  res.json({ saved: false, ...safe });
});

/** PUT /api/credentials/:provider — check, then encrypt and save if nothing failed. */
router.put('/:provider', async (req: Request, res: Response) => {
  const provider = req.params.provider;
  if (!isProviderName(provider)) return badProvider(res, provider);
  if (!encryptionReady()) {
    return res.status(503).json({
      error: 'This server can\'t store cloud keys safely yet.',
      code: 'ENCRYPTION_NOT_CONFIGURED',
      tip: 'Whoever runs this app must set CREDENTIALS_ENCRYPTION_KEY on the backend (Railway) — e.g. the output of `openssl rand -hex 32` — and redeploy. Nothing was saved.',
    });
  }
  if (!allowCheck(req.userId!)) {
    return res.status(429).json({ error: 'Too many checks in a minute.', tip: 'Wait a moment and try again.' });
  }

  const result: any = await runChecks(provider, cleanInput(provider, req.body), req.body?.region);
  const { secret, ...safe } = result;
  if (!result.ok || !secret) {
    return res.status(422).json({ saved: false, ...safe, error: 'Not saved — fix the failed checks above and try again.' });
  }
  try {
    await saveCredentials(req.userId!, provider, secret, result.metadata, { ok: true, summary: result.summary });
    res.json({ saved: true, ...safe });
  } catch (error) {
    if (error instanceof FriendlyCloudError) {
      return res.status(503).json({ saved: false, error: error.friendly.title, tip: error.friendly.fixes.join(' '), friendly: error.friendly });
    }
    console.error('Save credentials error:', error);
    res.status(500).json({ saved: false, error: 'Checks passed, but saving failed.', tip: 'Try again; if it persists, the database may be down.' });
  }
});

/** POST /api/credentials/:provider/recheck — re-test what's saved. */
router.post('/:provider/recheck', async (req: Request, res: Response) => {
  const provider = req.params.provider;
  if (!isProviderName(provider)) return badProvider(res, provider);
  if (!allowCheck(req.userId!)) {
    return res.status(429).json({ error: 'Too many checks in a minute.', tip: 'Wait a moment and try again.' });
  }
  try {
    const row = await query('SELECT encrypted_data, metadata FROM cloud_credentials WHERE user_id = $1 AND provider = $2', [req.userId, provider]);
    if (row.rows.length === 0) {
      return res.status(404).json({ error: `No ${PROVIDER_LABELS[provider]} keys saved.`, tip: 'Add them first.' });
    }
    const secret = decryptCredentials(req.userId!, provider, row.rows[0].encrypted_data);
    // Stored secrets are objects; the checks expect the form's string fields.
    const input: Record<string, string> = {};
    for (const [k, v] of Object.entries(secret || {})) input[k] = typeof v === 'string' ? v : JSON.stringify(v);
    const result: any = await runChecks(provider, input, req.body?.region || row.rows[0].metadata?.region);
    await recordCheck(req.userId!, provider, { ok: result.ok, summary: result.summary });
    const { secret: _s, ...safe } = result;
    res.json({ saved: true, ...safe });
  } catch (error) {
    if (error instanceof FriendlyCloudError) {
      return res.status(422).json({ error: error.friendly.title, tip: error.friendly.fixes.join(' '), friendly: error.friendly });
    }
    console.error('Recheck credentials error:', error);
    res.status(500).json({ error: 'Couldn\'t re-check your keys.', tip: 'Try again in a moment.' });
  }
});

/** DELETE /api/credentials/:provider — refuses if machines still exist, unless ?force=true. */
router.delete('/:provider', async (req: Request, res: Response) => {
  const provider = req.params.provider;
  if (!isProviderName(provider)) return badProvider(res, provider);
  try {
    const machines = await query(
      `SELECT COUNT(*) AS n FROM machines WHERE user_id = $1 AND provider = $2 AND status NOT IN ('failed', 'missing')`,
      [req.userId, provider]
    );
    const count = Number(machines.rows[0].n);
    if (count > 0 && req.query.force !== 'true') {
      return res.status(409).json({
        error: `You still have ${count} ${PROVIDER_LABELS[provider]} machine${count === 1 ? '' : 's'}.`,
        code: 'MACHINES_EXIST',
        tip: 'Without keys, the app can\'t stop or delete them — they\'d keep billing. Delete them first, or remove the keys anyway if you\'ll manage them in the cloud console.',
      });
    }
    const removed = await deleteCredentials(req.userId!, provider);
    res.json({ removed });
  } catch (error) {
    console.error('Delete credentials error:', error);
    res.status(500).json({ error: 'Failed to remove the keys', tip: 'Try again in a moment.' });
  }
});

export default router;
