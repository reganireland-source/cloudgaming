/**
 * ============================================================================
 * src/api/middleware/auth.ts — "IS THIS REQUEST FROM A LOGGED-IN USER?"
 * ============================================================================
 *
 * HOW LOGIN WORKS IN THIS APP (JWTs)
 * ----------------------------------
 * When a user logs in, the backend gives them a TOKEN — a JWT ("JSON Web
 * Token", pronounced "jot"). It's a long string containing some data (the
 * user's id and email) plus a cryptographic SIGNATURE made with our secret
 * (JWT_SECRET).
 *
 * The browser stores the token and sends it with every later request in a
 * header:
 *     Authorization: Bearer eyJhbGciOi...
 *
 * On each request we VERIFY the signature. If anyone altered the token (e.g.
 * changed the user id to someone else's), the signature no longer matches
 * and verification fails. Only a server that knows JWT_SECRET can produce a
 * valid signature — which is why that secret must stay secret.
 *
 * This means the server doesn't have to look up a "session" in the database
 * on every request — the token itself proves who you are.
 *
 * WHAT'S IN THIS FILE
 * -------------------
 *   authMiddleware — runs before protected routes; rejects requests without
 *                    a valid token, and otherwise attaches the user's id to
 *                    the request so routes know who is asking.
 *   generateJWT    — creates a token when someone logs in.
 * ============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken'; // the library that signs and verifies JWTs
import { env } from '../../config/env';
import { JWTPayload } from '../../types';

// ---------------------------------------------------------------------------
// TEACHING TYPESCRIPT ABOUT OUR EXTRA FIELDS
// Express's built-in `Request` type doesn't have `userId` or `email`. This
// "declaration merging" block adds them, so the compiler allows
// `req.userId` everywhere. They're marked optional (`?`) because they only
// exist AFTER authMiddleware has run — which is also why route code checks
// `if (!userId)` before using it.
// This block contains types only; it produces no runtime code.
// ---------------------------------------------------------------------------
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      email?: string;
    }
  }
}

/**
 * Middleware that protects routes. In src/index.ts it's placed in front of
 * routers, e.g. `app.use('/api/machines', authMiddleware, machineRoutes)`.
 *
 * Outcomes:
 *   - No token        -> 401 "Missing authorization token" (stop here)
 *   - Invalid/expired -> 401 "Invalid token" (stop here)
 *   - Valid           -> sets req.userId / req.email, calls next() so the
 *                        request continues to the real route
 *
 * 401 = "Unauthorized": the standard HTTP code for "you need to log in".
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // The header looks like "Bearer <token>". `.split(' ')` breaks it at the
  // space into ["Bearer", "<token>"], and `[1]` takes the token part.
  // The `?.` ("optional chaining") safely gives `undefined` instead of
  // crashing if there's no Authorization header at all.
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    // `return` stops this function here, so next() is never called and the
    // request goes no further.
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  try {
    // jwt.verify checks the signature AND the expiry date. It THROWS an
    // error if either is wrong, which lands us in the `catch` below.
    // `as JWTPayload` tells TypeScript what shape the decoded data has.
    const payload = jwt.verify(token, env.JWT_SECRET) as JWTPayload;

    // Attach who-this-is to the request for the route handlers to use.
    req.userId = payload.userId;
    req.email = payload.email;

    next(); // all good — continue to the route
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Create a signed login token for a user. Called by the login/sign-up
 * routes. The token is valid for 7 days, after which the user must log in
 * again.
 *
 * @returns the token string to send back to the browser
 */
export function generateJWT(userId: string, email: string): string {
  return jwt.sign(
    { userId, email },    // the data stored inside the token (readable by anyone — never put secrets here)
    env.JWT_SECRET,       // the secret used to sign it
    { expiresIn: '7d' }   // expiry: 7 days
  );
}
