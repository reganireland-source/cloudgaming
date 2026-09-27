/**
 * ============================================================================
 * src/api/routes/auth.ts — ACCOUNTS: SIGN UP, SIGN IN, GOOGLE / APPLE
 * ============================================================================
 *
 * Mounted in src/index.ts at /api/auth (WITHOUT the login check, because
 * you can't require being signed in to sign in). Routes:
 *
 *   GET  /api/auth/providers                 which sign-in options are switched on
 *   POST /api/auth/register                  create an account (email + password)
 *   POST /api/auth/login                     sign in (email + password)
 *   GET  /api/auth/me                        who am I?            (needs a token)
 *   GET  /api/auth/oauth/:provider/start     go to Google / Apple sign-in
 *   GET  /api/auth/oauth/:provider/callback  Google comes back here
 *   POST /api/auth/oauth/:provider/callback  Apple comes back here (a form POST)
 *
 * HOW A ROUTE HANDLER WORKS (applies to every routes file)
 * --------------------------------------------------------
 *   router.post('/login', async (req, res) => { ... })
 *     - `req` = what the browser sent (req.body JSON, req.params URL parts,
 *       req.query ?key=value, req.headers); `res` = how we reply.
 *     - res.status(401).json({...}) sets the HTTP status and sends JSON.
 *
 * ERRORS
 * ------
 * Every failure replies with { error, code, tip } — `error` says what went
 * wrong and `tip` what to do. The login page shows both.
 *
 * SESSION TOKENS
 * --------------
 * A successful sign-in returns a JWT (see middleware/auth.ts) valid for 7
 * days. The frontend sends it as "Authorization: Bearer <token>".
 * Cloud credentials are NOT handled here any more — see routes/credentials.ts.
 * ============================================================================
 */

import express, { Router, Request, Response } from 'express';
import { authMiddleware, generateJWT } from '../middleware/auth';
import { env } from '../../config/env';
import {
  AuthError,
  MIN_PASSWORD_LENGTH,
  checkLoginAllowed,
  clearLoginFailures,
  findOrCreateOAuthUser,
  getPublicUser,
  loginWithPassword,
  recordLoginFailure,
  registerWithPassword,
} from '../../services/AuthService';
import { OAuthProvider, buildAuthorizeUrl, enabledProviders, handleCallback, missingConfig } from '../../services/OAuthService';

const router = Router();

/** Send an AuthError (or an unexpected error) in the standard shape. */
function sendError(res: Response, error: unknown, fallback: string) {
  if (error instanceof AuthError) {
    return res.status(error.status).json({ error: error.message, code: error.code, tip: error.tip });
  }
  console.error(`${fallback}:`, error);
  return res.status(500).json({
    error: fallback,
    code: 'SERVER_ERROR',
    tip: 'Something broke on our side. Try again in a moment; if it persists, the database may be down (check the DATABASE light).',
  });
}

function isProvider(value: string): value is OAuthProvider {
  return value === 'google' || value === 'apple';
}

/** GET /api/auth/providers — lets the login page decide which buttons to show. */
router.get('/providers', (_req: Request, res: Response) => {
  const enabled = enabledProviders();
  res.json({
    password: true,
    google: enabled.google,
    apple: enabled.apple,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    // Only names of missing settings — never values — to help whoever sets up the app.
    setupHints: {
      google: enabled.google ? [] : missingConfig('google'),
      apple: enabled.apple ? [] : missingConfig('apple'),
    },
  });
});

/** POST /api/auth/register — body: { email, password, displayName? } */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, displayName } = req.body || {};
    const user = await registerWithPassword(email, password, displayName);
    res.status(201).json({ token: generateJWT(user.id, user.email), user });
  } catch (error) {
    sendError(res, error, 'Could not create the account');
  }
});

/** POST /api/auth/login — body: { email, password } */
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  // Limit failed attempts per email + IP address (brute-force protection).
  const limiterKey = `${String(email || '').toLowerCase()}|${req.ip}`;
  try {
    checkLoginAllowed(limiterKey);
    const user = await loginWithPassword(email, password);
    clearLoginFailures(limiterKey);
    res.json({ token: generateJWT(user.id, user.email), user });
  } catch (error) {
    if (error instanceof AuthError && error.status === 401) recordLoginFailure(limiterKey);
    sendError(res, error, 'Could not sign in');
  }
});

/** GET /api/auth/me — the signed-in user (needs a valid token). */
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await getPublicUser(req.userId!);
    if (!user) {
      return res.status(401).json({ error: 'Your account no longer exists.', code: 'NO_USER', tip: 'Sign in again or create a new account.' });
    }
    res.json({ user });
  } catch (error) {
    sendError(res, error, 'Could not load your account');
  }
});

// ---------------------------------------------------------------------------
// Google / Apple
// ---------------------------------------------------------------------------

/** Where the frontend's callback page lives. */
function frontendCallback(fragment: Record<string, string>): string {
  const base = env.FRONTEND_URL || '';
  return `${base}/auth/callback#${new URLSearchParams(fragment).toString()}`;
}

/** GET /api/auth/oauth/:provider/start?next=/machines */
router.get('/oauth/:provider/start', (req: Request, res: Response) => {
  const provider = req.params.provider;
  if (!isProvider(provider)) {
    return res.status(404).json({ error: 'Unknown sign-in provider.', code: 'UNKNOWN_PROVIDER' });
  }
  if (!enabledProviders()[provider]) {
    const missing = missingConfig(provider);
    const message = `${provider === 'google' ? 'Google' : 'Apple'} sign-in isn't set up on this server yet.`;
    const tip = `Whoever runs this app needs to set: ${missing.join(', ')}.`;
    // This is a page navigation, so send the browser back to the login page with the message.
    return env.FRONTEND_URL
      ? res.redirect(frontendCallback({ error: message, tip }))
      : res.status(503).json({ error: message, code: 'OAUTH_NOT_CONFIGURED', tip });
  }
  res.redirect(buildAuthorizeUrl(provider, req.query.next));
});

/** Shared by the GET (Google) and POST (Apple) callbacks. */
async function oauthCallback(req: Request, res: Response) {
  const provider = req.params.provider;
  if (!isProvider(provider)) return res.status(404).json({ error: 'Unknown sign-in provider.' });
  // Google puts the answer in the URL (?code=); Apple posts a form (body).
  const params = { ...req.query, ...(req.body || {}) };
  try {
    const profile = await handleCallback(provider, params);
    const user = await findOrCreateOAuthUser(profile);
    res.redirect(frontendCallback({ token: generateJWT(user.id, user.email), next: profile.next }));
  } catch (error) {
    if (!(error instanceof AuthError)) console.error(`[OAuth] ${provider} callback failed:`, error);
    const e = error instanceof AuthError
      ? error
      : new AuthError(500, 'OAUTH_FAILED', 'Sign-in failed on our side.', 'Try again in a moment.');
    res.redirect(frontendCallback({ error: e.message, tip: e.tip || '', code: e.code }));
  }
}

router.get('/oauth/:provider/callback', oauthCallback);
// Apple sends application/x-www-form-urlencoded, so parse that for this route.
router.post('/oauth/:provider/callback', express.urlencoded({ extended: false }), oauthCallback);

export default router;
