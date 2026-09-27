/**
 * ============================================================================
 * src/services/AuthService.ts — ACCOUNTS: PASSWORDS, SIGN-IN, LINKING
 * ============================================================================
 *
 * PASSWORDS
 * ---------
 * We never store a password. We store a SCRYPT HASH: a one-way scramble that
 * is deliberately slow and memory-hungry to compute, so an attacker who
 * steals the database can't cheaply guess passwords. Each password gets its
 * own random SALT, so two people with the same password get different hashes.
 * Stored format:  scrypt$N$r$p$<salt base64>$<hash base64>
 * (N, r, p are scrypt's cost settings, kept so they can be raised later.)
 * scrypt is built into Node — no native add-on that might fail to install.
 *
 * GOOGLE / APPLE
 * --------------
 * After Google or Apple confirms who someone is (src/services/OAuthService.ts),
 * findOrCreateOAuthUser() either finds their existing account or makes one.
 * If a password account already exists with the same VERIFIED email, the
 * new sign-in method is linked to it — one person, one account.
 *
 * ERRORS
 * ------
 * Methods throw AuthError, which carries an HTTP status and a plain-English
 * message + tip that the login page shows directly.
 * ============================================================================
 */

import crypto from 'crypto';
import { promisify } from 'util';
import { query } from '../config/database';

// promisify turns Node's callback-style scrypt into one we can `await`.
const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike, salt: crypto.BinaryLike, keylen: number, options: crypto.ScryptOptions
) => Promise<Buffer>;

// scrypt cost settings: N=16384, r=8, p=1 ≈ 16 MB of memory and ~50 ms per
// hash — slow for an attacker's billions of guesses, instant for one login.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export const MIN_PASSWORD_LENGTH = 10;

/** An error the login page can show as-is. */
export class AuthError extends Error {
  constructor(
    public readonly status: number,   // HTTP status to reply with
    public readonly code: string,     // stable id, e.g. 'EMAIL_TAKEN'
    message: string,                  // what went wrong
    public readonly tip?: string      // what to do about it
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  hasPassword: boolean;
  identities: string[]; // e.g. ['google']
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, n, r, p, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  // timingSafeEqual takes the same time whether the first or last byte
  // differs, so response timing can't leak how close a guess was.
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Rules for new passwords. Returns a problem message, or null if fine. */
export function passwordProblem(password: unknown, email?: string): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return 'That password is too long (200 characters max).';
  if (/^(.)\1+$/.test(password)) return 'That password is just one character repeated.';
  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4) {
    return 'Don\'t include your email name in your password.';
  }
  if (['password123', 'qwertyuiop', '1234567890', 'letmein123'].includes(password.toLowerCase())) {
    return 'That password is too common.';
  }
  return null;
}

// Deliberately simple: something@something.something, no spaces.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(email: unknown): string {
  const value = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(value) || value.length > 255) {
    throw new AuthError(400, 'BAD_EMAIL', 'That doesn\'t look like an email address.', 'Check for typos, e.g. name@example.com.');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function getPublicUser(userId: string): Promise<PublicUser | null> {
  const result = await query(
    `SELECT u.id, u.email, u.display_name, u.email_verified, (u.password_hash IS NOT NULL) AS has_password,
            COALESCE(ARRAY_AGG(i.provider) FILTER (WHERE i.provider IS NOT NULL), '{}') AS identities
     FROM users u LEFT JOIN user_identities i ON i.user_id = u.id
     WHERE u.id = $1
     GROUP BY u.id`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    emailVerified: row.email_verified,
    hasPassword: row.has_password,
    identities: row.identities,
  };
}

/** Create an email + password account. */
export async function registerWithPassword(emailInput: unknown, password: unknown, displayName?: unknown): Promise<PublicUser> {
  const email = normaliseEmail(emailInput);
  const problem = passwordProblem(password, email);
  if (problem) throw new AuthError(400, 'WEAK_PASSWORD', `Password not accepted: ${problem}`, 'A few random words together make a strong, memorable password.');

  const name = typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 255) : null;
  const passwordHash = await hashPassword(password as string);

  const existing = await query(
    `SELECT u.id, u.password_hash, (SELECT COUNT(*) FROM user_identities i WHERE i.user_id = u.id) AS identity_count
     FROM users u WHERE LOWER(u.email) = $1`,
    [email]
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.password_hash || Number(row.identity_count) > 0) {
      throw new AuthError(409, 'EMAIL_TAKEN', 'An account with this email already exists.',
        Number(row.identity_count) > 0 && !row.password_hash
          ? 'This email signed up with Google or Apple — use that button instead.'
          : 'Sign in instead. (Password reset isn\'t available yet — ask whoever runs this app.)');
    }
    // An old account from before passwords existed: claim it by setting one.
    await query('UPDATE users SET password_hash = $1, display_name = COALESCE($2, display_name) WHERE id = $3',
      [passwordHash, name, row.id]);
    return (await getPublicUser(row.id))!;
  }

  const created = await query(
    'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id',
    [email, passwordHash, name]
  );
  return (await getPublicUser(created.rows[0].id))!;
}

/** Check an email + password. Same error for "no such user" and "wrong password". */
export async function loginWithPassword(emailInput: unknown, password: unknown): Promise<PublicUser> {
  const email = normaliseEmail(emailInput);
  const result = await query(
    `SELECT u.id, u.password_hash, (SELECT COUNT(*) FROM user_identities i WHERE i.user_id = u.id) AS identity_count
     FROM users u WHERE LOWER(u.email) = $1`,
    [email]
  );
  const row = result.rows[0];
  const ok = typeof password === 'string' && (await verifyPassword(password, row?.password_hash ?? null));

  if (!ok) {
    // A Google/Apple-only account has no password; say so, since that's the
    // most common reason for "wrong password" on such accounts.
    if (row && !row.password_hash && Number(row.identity_count) > 0) {
      throw new AuthError(401, 'USE_SOCIAL_LOGIN', 'This account signs in with Google or Apple.',
        'Use the "Continue with Google" or "Continue with Apple" button.');
    }
    throw new AuthError(401, 'BAD_CREDENTIALS', 'Email or password is incorrect.',
      'Check caps lock, or create an account if you haven\'t yet.');
  }

  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [row.id]);
  return (await getPublicUser(row.id))!;
}

/**
 * Called after Google/Apple confirm who someone is. Finds or creates their
 * account, linking by verified email where possible.
 */
export async function findOrCreateOAuthUser(params: {
  provider: 'google' | 'apple';
  subject: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
}): Promise<PublicUser> {
  const { provider, subject } = params;

  // 1. Seen this Google/Apple identity before? Then we know the user.
  const known = await query('SELECT user_id FROM user_identities WHERE provider = $1 AND subject = $2', [provider, subject]);
  if (known.rows.length > 0) {
    const userId = known.rows[0].user_id;
    await query('UPDATE user_identities SET last_used_at = NOW() WHERE provider = $1 AND subject = $2', [provider, subject]);
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [userId]);
    return (await getPublicUser(userId))!;
  }

  if (!params.email) {
    throw new AuthError(400, 'NO_EMAIL', `${provider === 'google' ? 'Google' : 'Apple'} didn't share an email address.`,
      'Allow access to your email when asked, then try again.');
  }
  const email = params.email.trim().toLowerCase();

  // 2. An account with the same email? Only link if the provider VERIFIED
  //    the email — otherwise someone could claim your account by creating a
  //    Google/Apple login with your address.
  const byEmail = await query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
  let userId: string;
  if (byEmail.rows.length > 0) {
    if (!params.emailVerified) {
      throw new AuthError(409, 'EMAIL_TAKEN_UNVERIFIED', 'An account with this email already exists.',
        'Sign in with your password instead.');
    }
    userId = byEmail.rows[0].id;
    await query('UPDATE users SET email_verified = TRUE, display_name = COALESCE(display_name, $1) WHERE id = $2',
      [params.displayName || null, userId]);
  } else {
    // 3. Brand new person: create the account.
    const created = await query(
      'INSERT INTO users (email, display_name, email_verified) VALUES ($1, $2, $3) RETURNING id',
      [email, params.displayName || null, params.emailVerified]
    );
    userId = created.rows[0].id;
  }

  await query(
    `INSERT INTO user_identities (user_id, provider, subject, email) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, subject) DO NOTHING`,
    [userId, provider, subject, email]
  );
  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [userId]);
  return (await getPublicUser(userId))!;
}

// ---------------------------------------------------------------------------
// Brute-force protection
// ---------------------------------------------------------------------------
// A simple in-memory limiter: at most 8 failed logins per email+IP in 15
// minutes. It resets when the server restarts and isn't shared between
// servers, which is fine for a single Railway instance.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const failures = new Map<string, { count: number; firstAt: number }>();

export function checkLoginAllowed(key: string): void {
  const entry = failures.get(key);
  if (entry && Date.now() - entry.firstAt < WINDOW_MS && entry.count >= MAX_FAILURES) {
    const minutes = Math.ceil((WINDOW_MS - (Date.now() - entry.firstAt)) / 60000);
    throw new AuthError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts.',
      `Wait about ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`);
  }
}

export function recordLoginFailure(key: string): void {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.firstAt >= WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: Date.now() });
  } else {
    entry.count += 1;
  }
}

export function clearLoginFailures(key: string): void {
  failures.delete(key);
}
