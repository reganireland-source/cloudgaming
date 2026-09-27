/**
 * ============================================================================
 * src/services/CredentialService.ts — EACH USER'S CLOUD KEYS, ENCRYPTED AT REST
 * ============================================================================
 *
 * Users add their own cloud credentials on the Config page. This file is the
 * ONLY place that encrypts, decrypts, stores or loads them.
 *
 * HOW THE ENCRYPTION WORKS
 * ------------------------
 * - Algorithm: AES-256-GCM, a standard "authenticated" cipher. It both hides
 *   the data AND detects any tampering (decrypting altered data fails).
 * - Master key: derived from the CREDENTIALS_ENCRYPTION_KEY variable on the
 *   backend (Railway). It is never stored in the database, so a stolen
 *   database copy alone reveals nothing.
 * - A fresh random 12-byte IV ("initialisation vector") per save, so saving
 *   the same key twice gives different ciphertext.
 * - "Additional authenticated data" = "<userId>:<provider>". It isn't
 *   secret, but decryption only succeeds with the same value, so a row copied
 *   onto another user (or another cloud) can't be decrypted.
 * - Stored text: v1:<iv>:<auth tag>:<ciphertext>   (base64 parts)
 *
 * WHAT IS NEVER DONE
 * ------------------
 * - Secrets are never returned to the browser. The UI only ever gets the
 *   `metadata` summary (project id, service account email, key id...).
 * - Secrets are never logged. Operation logs mention the project, not keys.
 * ============================================================================
 */

import crypto from 'crypto';
import { query } from '../config/database';
import { env } from '../config/env';
import { FriendlyCloudError } from '../providers/gcp/errors';
import { getProvider, CloudProvider } from '../providers';
import type { Reporter } from './OperationLog';

export type ProviderName = 'aws' | 'azure' | 'gcp' | 'oracle';
export const PROVIDER_NAMES: ProviderName[] = ['aws', 'azure', 'gcp', 'oracle'];
export const PROVIDER_LABELS: Record<ProviderName, string> = {
  aws: 'Amazon Web Services',
  azure: 'Microsoft Azure',
  gcp: 'Google Cloud',
  oracle: 'Oracle Cloud',
};

// ---------------------------------------------------------------------------
// The master key
// ---------------------------------------------------------------------------

let cachedKey: Buffer | null = null;

/** Is the server able to encrypt credentials at all? */
export function encryptionReady(): boolean {
  return env.CREDENTIALS_ENCRYPTION_KEY.length >= 32;
}

function masterKey(): Buffer {
  if (!encryptionReady()) {
    throw new FriendlyCloudError({
      code: 'ENCRYPTION_NOT_CONFIGURED',
      title: 'This server can\'t store cloud keys safely yet',
      explanation:
        'Cloud keys are encrypted before they are saved, and the server\'s encryption key (CREDENTIALS_ENCRYPTION_KEY) hasn\'t been set up. Nothing was saved.',
      fixes: [
        'Whoever runs this app: on Railway → backend service → Variables, add CREDENTIALS_ENCRYPTION_KEY.',
        'Its value should be a long random string — for example the output of: openssl rand -hex 32',
        'Redeploy, then try again. Don\'t change it later, or saved keys can\'t be read.',
      ],
    });
  }
  if (!cachedKey) {
    // scrypt stretches whatever text was provided into exactly 32 bytes.
    // The fixed salt is fine here: the input is already a high-entropy secret.
    cachedKey = crypto.scryptSync(env.CREDENTIALS_ENCRYPTION_KEY, 'cloudgaming-credentials-v1', 32);
  }
  return cachedKey;
}

export function encryptCredentials(userId: string, provider: string, secret: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  cipher.setAAD(Buffer.from(`${userId}:${provider}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptCredentials(userId: string, provider: string, stored: string): any {
  const [version, ivB64, tagB64, dataB64] = stored.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw unreadable(provider);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAAD(Buffer.from(`${userId}:${provider}`));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch (error) {
    if (error instanceof FriendlyCloudError) throw error;
    throw unreadable(provider);
  }
}

function unreadable(provider: string): FriendlyCloudError {
  return new FriendlyCloudError({
    code: 'CREDENTIALS_UNREADABLE',
    title: `Your saved ${PROVIDER_LABELS[provider as ProviderName] || provider} keys can't be read`,
    explanation:
      'They were encrypted with a different server key (the server\'s CREDENTIALS_ENCRYPTION_KEY probably changed), so they can no longer be decrypted.',
    fixes: ['On the Config page, remove these credentials and add them again.'],
  });
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface CredentialSummary {
  provider: ProviderName;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckSummary: string | null;
}

/** What the Config page shows: which clouds are set up — no secrets. */
export async function listCredentialSummaries(userId: string): Promise<CredentialSummary[]> {
  const result = await query(
    `SELECT provider, metadata, created_at, updated_at, last_checked_at, last_check_ok, last_check_summary
     FROM cloud_credentials WHERE user_id = $1 ORDER BY provider`,
    [userId]
  );
  return result.rows.map((r: any) => ({
    provider: r.provider,
    metadata: r.metadata || {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastCheckedAt: r.last_checked_at,
    lastCheckOk: r.last_check_ok,
    lastCheckSummary: r.last_check_summary,
  }));
}

export async function saveCredentials(
  userId: string,
  provider: ProviderName,
  secret: unknown,
  metadata: Record<string, unknown>,
  check: { ok: boolean; summary: string }
): Promise<void> {
  const encrypted = encryptCredentials(userId, provider, secret);
  await query(
    `INSERT INTO cloud_credentials
       (user_id, provider, encrypted_data, metadata, updated_at, last_checked_at, last_check_ok, last_check_summary)
     VALUES ($1, $2, $3, $4, NOW(), NOW(), $5, $6)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       encrypted_data = EXCLUDED.encrypted_data,
       metadata = EXCLUDED.metadata,
       updated_at = NOW(),
       last_checked_at = NOW(),
       last_check_ok = EXCLUDED.last_check_ok,
       last_check_summary = EXCLUDED.last_check_summary`,
    [userId, provider, encrypted, JSON.stringify(metadata), check.ok, check.summary]
  );
}

export async function recordCheck(userId: string, provider: ProviderName, check: { ok: boolean; summary: string }) {
  await query(
    `UPDATE cloud_credentials SET last_checked_at = NOW(), last_check_ok = $3, last_check_summary = $4
     WHERE user_id = $1 AND provider = $2`,
    [userId, provider, check.ok, check.summary]
  );
}

export async function deleteCredentials(userId: string, provider: ProviderName): Promise<boolean> {
  const result = await query('DELETE FROM cloud_credentials WHERE user_id = $1 AND provider = $2 RETURNING id', [userId, provider]);
  return result.rows.length > 0;
}

/**
 * Load and decrypt a user's credentials for one cloud.
 * Throws a friendly "add your keys on the Config page" error if missing.
 */
export async function loadCredentials(userId: string, provider: string): Promise<any> {
  const result = await query(
    'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
    [userId, provider]
  );
  if (result.rows.length === 0) {
    const label = PROVIDER_LABELS[provider as ProviderName] || provider;
    throw new FriendlyCloudError({
      code: 'NO_CREDENTIALS',
      title: `You haven't added ${label} credentials yet`,
      explanation: `Gints Global Gaming Hubjob works inside YOUR ${label} account, so it needs a limited-access key for it.`,
      fixes: [
        'Open the Config page.',
        `Pick ${label} and follow the setup guide to create a key.`,
        'Add it there — it\'s checked and then stored encrypted.',
      ],
    });
  }
  return decryptCredentials(userId, provider, result.rows[0].encrypted_data);
}

/**
 * The usual starting point for any cloud action: load the user's keys and
 * return a ready provider object, optionally wired to an operation log.
 */
export async function providerFor(userId: string, provider: string, reporter?: Reporter): Promise<CloudProvider> {
  const credentials = await loadCredentials(userId, provider);
  return getProvider(provider, credentials).setReporter(reporter);
}
