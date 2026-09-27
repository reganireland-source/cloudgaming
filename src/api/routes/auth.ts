/**
 * ============================================================================
 * src/api/routes/auth.ts — ACCOUNTS: REGISTER, LOG IN, SAVE CLOUD LOGINS
 * ============================================================================
 *
 * Mounted in src/index.ts at /api/auth, so the routes below answer:
 *   POST /api/auth/register           create an account, get a login token
 *   POST /api/auth/login              log in, get a login token
 *   POST /api/auth/cloud-credentials  save your AWS/Azure/GCP/Oracle keys
 *   GET  /api/auth/me                 who am I?
 *
 * HOW A ROUTE HANDLER WORKS (applies to every routes file)
 * --------------------------------------------------------
 *   router.post('/login', async (req, res) => { ... })
 *     - `router.post` = answer HTTP POST requests (GET reads, POST creates/acts,
 *       PUT/PATCH update, DELETE removes).
 *     - `req` (request)  = what the browser sent: req.body (JSON data),
 *       req.params (parts of the URL like :id), req.query (?key=value),
 *       req.headers.
 *     - `res` (response) = how we reply: res.json(data) sends JSON;
 *       res.status(404) sets the HTTP status code first.
 *     - `async` lets us `await` slow things like database queries.
 *
 * Common HTTP status codes used below:
 *   200 OK (default)   400 Bad Request (the client sent bad/missing data)
 *   401 Unauthorized   404 Not Found   409 Conflict (e.g. already exists)
 *   500 Internal Server Error (something broke on our side)
 *
 * ⚠️  KNOWN LIMITATIONS — read before going to production
 * -----------------------------------------------------
 * 1. NO PASSWORDS. /login hands out a token to anyone who supplies an email
 *    that exists. Anyone who knows (or guesses) your email can log in as
 *    you. A real password check or an OAuth provider (e.g. "Sign in with
 *    Google") is needed before real users or real cloud keys are involved.
 * 2. /cloud-credentials and /me read `req.userId`, which is only set by
 *    authMiddleware. But in src/index.ts this whole router is mounted
 *    WITHOUT authMiddleware (so that /register and /login work while logged
 *    out). As a result, req.userId is always empty here and those two
 *    endpoints always answer 400/401. Fix: add authMiddleware to just those
 *    two routes.
 * 3. Credentials are stored exactly as sent — NOT encrypted, despite the
 *    column name `encrypted_data`.
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { query } from '../../config/database';
import { generateJWT } from '../middleware/auth';

// A Router is a mini-app that holds a group of routes. It's exported at the
// bottom and plugged into the main app in src/index.ts.
const router = Router();

/**
 * POST /api/auth/register
 * Create a new user account.
 * Request body: { "email": "you@example.com" }
 * Response:     { userId, email, token }  — the token is used for later requests.
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    // "Destructuring": pull the `email` field out of the request body into
    // a variable of the same name.
    const { email } = req.body;

    // Validate input early and stop with a helpful message if it's missing.
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    // Refuse to create a duplicate account for the same email.
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'User already exists' });
    }

    // Insert the new user. `RETURNING id, email` makes Postgres send back
    // the row it just created — including the id the database generated —
    // so we don't need a second query to find it.
    const result = await query(
      'INSERT INTO users (email) VALUES ($1) RETURNING id, email',
      [email]
    );

    const user = result.rows[0];

    // Log the new user straight in by issuing a token.
    const token = generateJWT(user.id, user.email);

    res.json({ userId: user.id, email: user.email, token });
  } catch (error) {
    // Anything unexpected (e.g. the database is down): log the real details
    // for us, return a generic message to the browser.
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/login
 * Log in with an email address and receive a token.
 * ⚠️ No password check — see KNOWN LIMITATIONS at the top of this file.
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    // Look the user up by email.
    const result = await query(
      'SELECT id, email FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const token = generateJWT(user.id, user.email);

    res.json({ userId: user.id, email: user.email, token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/cloud-credentials
 * Save (or replace) the logged-in user's login details for one cloud provider.
 * Request body: { "provider": "aws", "encryptedData": "<text>" }
 * ⚠️ Currently always fails with 400 (req.userId is never set here), and
 *    the data isn't really encrypted — see KNOWN LIMITATIONS above.
 */
router.post('/cloud-credentials', async (req: Request, res: Response) => {
  try {
    const { provider, encryptedData } = req.body;
    const userId = req.userId;

    if (!userId || !provider || !encryptedData) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // This is an "UPSERT" (update-or-insert):
    //   - INSERT a new row for this user+provider...
    //   - ...but if one already exists (the table has a UNIQUE rule on
    //     user_id + provider, so each user has at most one AWS login etc.),
    //     `ON CONFLICT ... DO UPDATE` overwrites the saved data instead of
    //     failing with a duplicate error.
    const result = await query(
      `INSERT INTO cloud_credentials (user_id, provider, encrypted_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, provider) DO UPDATE SET encrypted_data = $3
       RETURNING id`,
      [userId, provider, encryptedData]
    );

    res.json({ credentialsId: result.rows[0].id });
  } catch (error) {
    console.error('Cloud credentials error:', error);
    res.status(500).json({ error: 'Failed to store credentials' });
  }
});

/**
 * GET /api/auth/me
 * Return the logged-in user's profile and budget settings.
 * ⚠️ Currently always answers 401 — see KNOWN LIMITATIONS above.
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const result = await query(
      'SELECT id, email, budget_cap, budget_alert_threshold FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // The database uses snake_case column names (budget_cap); the frontend
    // expects camelCase (budgetCap), so we rename fields on the way out.
    res.json({
      id: user.id,
      email: user.email,
      budgetCap: user.budget_cap,
      budgetAlertThreshold: user.budget_alert_threshold,
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

export default router;
