/**
 * ============================================================================
 * src/services/OAuthService.ts — "CONTINUE WITH GOOGLE / APPLE"
 * ============================================================================
 *
 * THE FLOW (OpenID Connect "authorization code" flow)
 * ---------------------------------------------------
 *  1. The login page links to  GET /api/auth/oauth/google/start
 *  2. We redirect the browser to Google's sign-in page, passing:
 *       - our client id and the callback address
 *       - `state`: a short-lived token WE signed, holding where to send the
 *         user afterwards and a random `nonce`. Google hands it back
 *         untouched, which proves the callback belongs to a sign-in we started.
 *  3. The person signs in at Google; Google redirects back to
 *       /api/auth/oauth/google/callback?code=...&state=...
 *     (Apple instead POSTs a form to the same path.)
 *  4. We swap the one-time `code` for an ID TOKEN by calling Google directly,
 *     server to server, with our client secret.
 *  5. The ID token is a JWT signed by Google. We check the signature against
 *     Google's published public keys, and that it's for OUR app (aud), from
 *     Google (iss), not expired, and carries our nonce.
 *  6. Its `sub` (Google's permanent id for the person) and email are used to
 *     find or create the account (AuthService.findOrCreateOAuthUser).
 *  7. We redirect to the frontend's /auth/callback page with OUR session
 *     token in the URL FRAGMENT (#token=...). Fragments are never sent to
 *     servers, so the token doesn't end up in anyone's access logs.
 *
 * Apple differences: the "client secret" is itself a JWT we sign with the
 * app's Apple private key (.p8, ES256), and the person's name is only sent
 * on their very first sign-in, in a `user` form field.
 * ============================================================================
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AuthError } from './AuthService';

export type OAuthProvider = 'google' | 'apple';

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  issuer: string;
  scope: string;
}

const PROVIDERS: Record<OAuthProvider, ProviderConfig> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    issuer: 'https://accounts.google.com',
    scope: 'openid email profile',
  },
  apple: {
    authorizeUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    issuer: 'https://appleid.apple.com',
    scope: 'name email',
  },
};

/** Which sign-in buttons should the login page show? */
export function enabledProviders(): Record<OAuthProvider, boolean> {
  const base = !!env.API_PUBLIC_URL && !!env.FRONTEND_URL;
  return {
    google: base && !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET,
    apple: base && !!env.APPLE_CLIENT_ID && !!env.APPLE_TEAM_ID && !!env.APPLE_KEY_ID && !!env.APPLE_PRIVATE_KEY,
  };
}

/** What's missing for a provider — shown to whoever sets the app up. */
export function missingConfig(provider: OAuthProvider): string[] {
  const need: Array<[string, string]> = [['API_PUBLIC_URL', env.API_PUBLIC_URL], ['FRONTEND_URL', env.FRONTEND_URL]];
  if (provider === 'google') {
    need.push(['GOOGLE_CLIENT_ID', env.GOOGLE_CLIENT_ID], ['GOOGLE_CLIENT_SECRET', env.GOOGLE_CLIENT_SECRET]);
  } else {
    need.push(['APPLE_CLIENT_ID', env.APPLE_CLIENT_ID], ['APPLE_TEAM_ID', env.APPLE_TEAM_ID],
      ['APPLE_KEY_ID', env.APPLE_KEY_ID], ['APPLE_PRIVATE_KEY', env.APPLE_PRIVATE_KEY]);
  }
  return need.filter(([, value]) => !value).map(([name]) => name);
}

function clientId(provider: OAuthProvider): string {
  return provider === 'google' ? env.GOOGLE_CLIENT_ID : env.APPLE_CLIENT_ID;
}

export function callbackUrl(provider: OAuthProvider): string {
  return `${env.API_PUBLIC_URL}/auth/oauth/${provider}/callback`;
}

/** Only allow sending people back to paths on our own frontend. */
function safeNextPath(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/machines';
}

// ---------------------------------------------------------------------------
// Step 2: build the provider's sign-in URL
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(provider: OAuthProvider, next: unknown): string {
  const cfg = PROVIDERS[provider];
  const nonce = crypto.randomBytes(16).toString('hex');
  // Signed with our JWT secret, valid 10 minutes: tamper-proof and short-lived.
  const state = jwt.sign({ p: provider, n: nonce, next: safeNextPath(next) }, env.JWT_SECRET, { expiresIn: '10m' });

  const params = new URLSearchParams({
    client_id: clientId(provider),
    redirect_uri: callbackUrl(provider),
    response_type: 'code',
    scope: cfg.scope,
    state,
    nonce,
  });
  if (provider === 'google') {
    params.set('prompt', 'select_account'); // always let people pick which Google account
  } else {
    params.set('response_mode', 'form_post'); // Apple requires this when asking for name/email
  }
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Step 5 helper: Google's / Apple's public signing keys (cached for an hour)
// ---------------------------------------------------------------------------

const jwksCache = new Map<string, { keys: any[]; fetchedAt: number }>();

async function getSigningKey(provider: OAuthProvider, kid: string): Promise<crypto.KeyObject> {
  const url = PROVIDERS[provider].jwksUrl;
  let cached = jwksCache.get(url);
  const stale = !cached || Date.now() - cached.fetchedAt > 60 * 60 * 1000;
  // Refetch if stale, or if the key id is unknown (the provider rotated keys).
  if (stale || !cached!.keys.some((k) => k.kid === kid)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download ${provider} signing keys (HTTP ${res.status})`);
    const body: any = await res.json();
    cached = { keys: body.keys || [], fetchedAt: Date.now() };
    jwksCache.set(url, cached);
  }
  const jwk = cached!.keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error(`${provider} token was signed with an unknown key (${kid})`);
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/** Apple's client secret: a JWT signed with the app's .p8 key (ES256). */
function appleClientSecret(): string {
  return jwt.sign({}, env.APPLE_PRIVATE_KEY, {
    algorithm: 'ES256',
    expiresIn: '5m',
    audience: 'https://appleid.apple.com',
    issuer: env.APPLE_TEAM_ID,
    subject: env.APPLE_CLIENT_ID,
    keyid: env.APPLE_KEY_ID,
  });
}

// ---------------------------------------------------------------------------
// Steps 4–5: handle the callback
// ---------------------------------------------------------------------------

export interface OAuthProfile {
  provider: OAuthProvider;
  subject: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
  next: string;
}

/**
 * Verify `state`, exchange `code` for an ID token, verify the ID token and
 * return who the person is. Throws AuthError with a readable message.
 */
export async function handleCallback(
  provider: OAuthProvider,
  params: { code?: unknown; state?: unknown; error?: unknown; user?: unknown }
): Promise<OAuthProfile> {
  const label = provider === 'google' ? 'Google' : 'Apple';

  if (params.error) {
    const cancelled = /access_denied|user_cancelled/i.test(String(params.error));
    throw new AuthError(400, cancelled ? 'OAUTH_CANCELLED' : 'OAUTH_ERROR',
      cancelled ? `${label} sign-in was cancelled.` : `${label} reported an error: ${params.error}`,
      cancelled ? 'Try again, or use email and password.' : 'Try again in a moment.');
  }

  let state: any;
  try {
    state = jwt.verify(String(params.state || ''), env.JWT_SECRET);
  } catch {
    throw new AuthError(400, 'OAUTH_STATE', 'That sign-in link expired or was tampered with.',
      'Start again from the login page (links are valid for 10 minutes).');
  }
  if (state.p !== provider) {
    throw new AuthError(400, 'OAUTH_STATE', 'That sign-in response doesn\'t match the provider.', 'Start again from the login page.');
  }
  if (!params.code) {
    throw new AuthError(400, 'OAUTH_NO_CODE', `${label} didn't send a sign-in code.`, 'Start again from the login page.');
  }

  // Exchange the code for tokens (server to server).
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(params.code),
    redirect_uri: callbackUrl(provider),
    client_id: clientId(provider),
    client_secret: provider === 'google' ? env.GOOGLE_CLIENT_SECRET : appleClientSecret(),
  });
  const tokenRes = await fetch(PROVIDERS[provider].tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const tokens: any = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.id_token) {
    console.error(`[OAuth] ${provider} token exchange failed:`, tokenRes.status, tokens);
    throw new AuthError(502, 'OAUTH_EXCHANGE', `${label} didn't confirm the sign-in.`,
      tokens.error === 'invalid_client'
        ? 'The app\'s sign-in settings look wrong — tell whoever runs this app (client id/secret).'
        : 'Try again. If it keeps happening, tell whoever runs this app.');
  }

  // Verify the ID token's signature and claims.
  const decoded: any = jwt.decode(tokens.id_token, { complete: true });
  if (!decoded?.header?.kid) throw new AuthError(502, 'OAUTH_TOKEN', `${label} sent an unreadable ID token.`, 'Try again.');
  const key = await getSigningKey(provider, decoded.header.kid);
  let claims: any;
  try {
    claims = jwt.verify(tokens.id_token, key, {
      algorithms: ['RS256'],
      audience: clientId(provider),
      issuer: provider === 'google' ? [PROVIDERS.google.issuer, 'accounts.google.com'] : PROVIDERS.apple.issuer,
    });
  } catch (error) {
    console.error(`[OAuth] ${provider} ID token rejected:`, (error as Error).message);
    throw new AuthError(401, 'OAUTH_TOKEN', `We couldn't verify the ${label} sign-in.`, 'Try again.');
  }
  if (claims.nonce !== state.n) {
    throw new AuthError(401, 'OAUTH_NONCE', `The ${label} sign-in doesn't match this session.`, 'Start again from the login page.');
  }

  // Apple sends the person's name only on their first sign-in, as JSON text.
  let displayName: string | undefined = claims.name;
  if (provider === 'apple' && params.user) {
    try {
      const u = typeof params.user === 'string' ? JSON.parse(params.user) : params.user;
      displayName = [u?.name?.firstName, u?.name?.lastName].filter(Boolean).join(' ') || undefined;
    } catch {
      /* name is optional */
    }
  }

  return {
    provider,
    subject: String(claims.sub),
    email: claims.email,
    // Google sends a boolean; Apple sends the text "true" or a boolean.
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    displayName,
    next: state.next,
  };
}
