/**
 * ============================================================================
 * src/services/PreflightService.ts — "IS EVERYTHING SET UP BEFORE I LAUNCH?"
 * ============================================================================
 *
 * One checklist of the setup mistakes that otherwise only show up halfway
 * through signing in or launching a machine. Each check is
 * pass / warn / fail with a plain-English tip saying exactly where to fix it.
 *
 *   server      required variables, secret strength, public URL shape
 *   database    reachable, every migration applied
 *   encryption  the key is set and an encrypt → decrypt round-trip works;
 *               if you're signed in, YOUR saved cloud keys still decrypt
 *   sign-in     Google / Apple configured, and the exact callback URLs to
 *               register with them
 *   browser     the calling website is allowed by CORS (FRONTEND_URL)
 *   prices      the live spot-price feeds are reachable
 *
 * NEVER returns a secret: only whether it's set / how long / whether it
 * works. The URLs it shows are public anyway.
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { query } from '../config/database';
import { env } from '../config/env';
import { encryptionReady, encryptCredentials, decryptCredentials } from './CredentialService';
import { enabledProviders, missingConfig, callbackUrl } from './OAuthService';
import { spotFeedStatus } from './SpotPriceService';

export type PreflightStatus = 'pass' | 'warn' | 'fail';
export interface PreflightCheck {
  group: 'server' | 'database' | 'encryption' | 'sign-in' | 'browser' | 'prices';
  id: string;
  label: string;
  status: PreflightStatus;
  message: string;
  tip?: string;
  copy?: string[];   // values worth copying somewhere (callback URLs...)
}

const RAILWAY_VARS = 'Railway → your backend service → Variables';

export async function runPreflight(opts: { origin?: string; authorization?: string }): Promise<{ ok: boolean; summary: string; checks: PreflightCheck[]; checkedAt: string }> {
  const checks: PreflightCheck[] = [];
  const add = (c: PreflightCheck) => checks.push(c);

  // ---------------------------------------------------------------- server
  add(env.JWT_SECRET.length >= 32
    ? { group: 'server', id: 'jwt', label: 'Login token secret (JWT_SECRET)', status: 'pass', message: `Set (${env.JWT_SECRET.length} characters).` }
    : { group: 'server', id: 'jwt', label: 'Login token secret (JWT_SECRET)', status: 'warn', message: `Only ${env.JWT_SECRET.length} characters — easy to guess, so someone could forge logins.`,
        tip: `Generate one with \`openssl rand -hex 32\` and set it in ${RAILWAY_VARS}. Everyone will need to sign in again.` });

  if (!env.API_PUBLIC_URL) {
    add({ group: 'server', id: 'api-url', label: 'Public API address (API_PUBLIC_URL)', status: 'warn', message: 'Not set — Google/Apple sign-in and one-click Moonlight pairing need it.',
      tip: `In ${RAILWAY_VARS}, set API_PUBLIC_URL to your Railway address plus /api, e.g. https://<app>.up.railway.app/api` });
  } else {
    const problems: string[] = [];
    if (!/^https:\/\//.test(env.API_PUBLIC_URL) && !/^http:\/\/localhost(:\d+)?\//.test(env.API_PUBLIC_URL)) problems.push('should start with https://');
    if (!/\/api$/.test(env.API_PUBLIC_URL)) problems.push('should end with /api');
    add({ group: 'server', id: 'api-url', label: 'Public API address (API_PUBLIC_URL)', status: problems.length ? 'fail' : 'pass',
      message: problems.length ? `${env.API_PUBLIC_URL} — ${problems.join(' and ')}.` : env.API_PUBLIC_URL,
      tip: problems.length ? `Fix it in ${RAILWAY_VARS}, e.g. https://<app>.up.railway.app/api` : undefined });
  }

  // -------------------------------------------------------------- database
  const t0 = Date.now();
  let dbOk = false;
  try {
    await query('SELECT 1');
    dbOk = true;
    add({ group: 'database', id: 'db', label: 'Database connection', status: 'pass', message: `Connected (${Date.now() - t0} ms).` });
  } catch (error) {
    add({ group: 'database', id: 'db', label: 'Database connection', status: 'fail', message: `Can't reach the database: ${(error as Error).message}`,
      tip: `In ${RAILWAY_VARS}, DATABASE_URL should be the reference \${{Postgres.DATABASE_URL}} (pick it from the "Add reference" list).` });
  }
  if (dbOk) {
    try {
      const dir = path.join(__dirname, '../../database/migrations');
      const expected = ['000_schema.sql', ...(fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [])];
      const applied = new Set((await query('SELECT name FROM schema_migrations')).rows.map((r: any) => r.name));
      const missing = expected.filter((f) => !applied.has(f));
      add(missing.length
        ? { group: 'database', id: 'migrations', label: 'Database tables up to date', status: 'fail', message: `Not applied yet: ${missing.join(', ')}.`,
            tip: 'The backend applies these on start (npm start runs migrate first). Redeploy the backend on Railway, and check its deploy log for a [migrate] error.' }
        : { group: 'database', id: 'migrations', label: 'Database tables up to date', status: 'pass', message: `All ${expected.length} migrations applied.` });
    } catch (error) {
      add({ group: 'database', id: 'migrations', label: 'Database tables up to date', status: 'fail', message: `Couldn't read the migrations ledger: ${(error as Error).message}`,
        tip: 'Redeploy the backend so the migrations run.' });
    }
  }

  // ------------------------------------------------------------ encryption
  if (!encryptionReady()) {
    add({ group: 'encryption', id: 'enc-key', label: 'Cloud-key encryption (CREDENTIALS_ENCRYPTION_KEY)', status: 'fail',
      message: 'Not set (or shorter than 32 characters) — cloud keys can’t be saved.',
      tip: `Generate with \`openssl rand -hex 32\` and add it in ${RAILWAY_VARS}. Keep a copy somewhere safe: if it changes, saved keys can't be decrypted.` });
  } else {
    try {
      const probe = { probe: Date.now() };
      const back = decryptCredentials('preflight', 'probe', encryptCredentials('preflight', 'probe', probe));
      add({ group: 'encryption', id: 'enc-key', label: 'Cloud-key encryption (CREDENTIALS_ENCRYPTION_KEY)', status: back?.probe === probe.probe ? 'pass' : 'fail',
        message: back?.probe === probe.probe ? 'Set, and an encrypt → decrypt test worked.' : 'Round-trip test returned the wrong data.' });
    } catch (error) {
      add({ group: 'encryption', id: 'enc-key', label: 'Cloud-key encryption', status: 'fail', message: `Round-trip test failed: ${(error as Error).message}` });
    }
  }

  // Signed in? Check this user's saved keys still decrypt (key rotated = broken).
  const token = opts.authorization?.split(' ')[1];
  let userId: string | null = null;
  if (token) { try { userId = (jwt.verify(token, env.JWT_SECRET) as any).userId; } catch { /* not signed in */ } }
  if (userId && dbOk && encryptionReady()) {
    const rows = (await query('SELECT provider, encrypted_data FROM cloud_credentials WHERE user_id = $1 ORDER BY provider', [userId])).rows;
    if (!rows.length) {
      add({ group: 'encryption', id: 'my-keys', label: 'Your saved cloud keys', status: 'warn', message: 'None saved yet.', tip: 'Add at least one cloud on the Config page before launching.' });
    }
    for (const r of rows) {
      try {
        decryptCredentials(userId, r.provider, r.encrypted_data);
        add({ group: 'encryption', id: `my-keys-${r.provider}`, label: `Your ${r.provider.toUpperCase()} keys`, status: 'pass', message: 'Saved and readable.' });
      } catch {
        add({ group: 'encryption', id: `my-keys-${r.provider}`, label: `Your ${r.provider.toUpperCase()} keys`, status: 'fail',
          message: 'Saved, but can’t be decrypted — CREDENTIALS_ENCRYPTION_KEY has changed since they were saved.',
          tip: 'Remove and re-add these keys on the Config page (or put the old CREDENTIALS_ENCRYPTION_KEY back).' });
      }
    }
  }

  // --------------------------------------------------------------- sign-in
  const enabled = enabledProviders();
  for (const p of ['google', 'apple'] as const) {
    const label = p === 'google' ? 'Sign in with Google' : 'Sign in with Apple';
    if (enabled[p]) {
      add({ group: 'sign-in', id: p, label, status: 'pass', message: 'Configured. Make sure this exact callback URL is registered with ' + (p === 'google' ? 'Google (Credentials → your OAuth client → Authorized redirect URIs).' : 'Apple (Services ID → Return URLs).'),
        copy: [callbackUrl(p)] });
    } else {
      add({ group: 'sign-in', id: p, label, status: 'warn', message: `Off — missing ${missingConfig(p).join(', ')}. Email sign-in still works.`,
        tip: `Optional. Add the missing variables in ${RAILWAY_VARS}.`, copy: env.API_PUBLIC_URL ? [callbackUrl(p)] : undefined });
    }
  }

  // --------------------------------------------------------------- browser
  if (!env.FRONTEND_URL) {
    add({ group: 'browser', id: 'cors', label: 'Website allowed to call the API (FRONTEND_URL)', status: 'warn',
      message: 'Not set — any website may call this API.', tip: `Set FRONTEND_URL in ${RAILWAY_VARS} to your Vercel address, e.g. https://<app>.vercel.app (no trailing slash).` });
  } else if (opts.origin && opts.origin !== env.FRONTEND_URL && !/^http:\/\/localhost(:\d+)?$/.test(opts.origin)) {
    add({ group: 'browser', id: 'cors', label: 'Website allowed to call the API (FRONTEND_URL)', status: 'fail',
      message: `This page is on ${opts.origin}, but the API only allows ${env.FRONTEND_URL}.`,
      tip: `Browsers will block this site. Set FRONTEND_URL in ${RAILWAY_VARS} to ${opts.origin} (Vercel preview URLs differ from production).` });
  } else {
    add({ group: 'browser', id: 'cors', label: 'Website allowed to call the API (FRONTEND_URL)', status: 'pass', message: env.FRONTEND_URL });
  }

  // ---------------------------------------------------------------- prices
  const feeds = await spotFeedStatus().catch(() => ({ aws: { ok: false, ageMinutes: null }, azure: { ok: false } }));
  add({ group: 'prices', id: 'spot-aws', label: 'Live AWS spot prices', status: feeds.aws.ok ? 'pass' : 'warn',
    message: feeds.aws.ok ? `Reachable (data ${feeds.aws.ageMinutes} min old).` : 'Unreachable — estimates are used instead.' });
  add({ group: 'prices', id: 'spot-azure', label: 'Live Azure spot prices', status: feeds.azure.ok ? 'pass' : 'warn',
    message: feeds.azure.ok ? 'Reachable.' : 'Unreachable — estimates are used instead.' });

  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  return {
    ok: fails === 0,
    summary: fails ? `${fails} problem${fails === 1 ? '' : 's'} to fix before launching` : warns ? `Ready — ${warns} optional item${warns === 1 ? '' : 's'}` : 'All clear — ready for launch',
    checks,
    checkedAt: new Date().toISOString(),
  };
}
