/**
 * ============================================================================
 * src/config/env.ts — ALL CONFIGURATION, READ IN ONE PLACE
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Apps need settings that change between environments: the database address
 * on your laptop is different from the one on Railway, and secret keys must
 * never be written into the code. These settings are passed in as
 * ENVIRONMENT VARIABLES — named text values the operating system hands to
 * the program when it starts (on Railway you set them in the "Variables" tab).
 *
 * In Node.js, environment variables are available on `process.env`, e.g.
 * `process.env.PORT`. Rather than sprinkling `process.env.X` all over the
 * codebase, this file reads them ONCE, applies sensible defaults, converts
 * numbers from text to actual numbers, and exports a single `env` object.
 * Everywhere else just does `import { env } from '../config/env'`.
 *
 * WHY THIS MATTERS
 * ----------------
 * - One place to see every setting the app understands.
 * - Missing REQUIRED settings stop the app immediately at startup with a
 *   clear message ("Missing required environment variable: DATABASE_URL"),
 *   instead of failing in a confusing way later.
 *
 * NOTE: every environment variable is a STRING. That's why numeric settings
 * go through `parseInt(..., 10)` — the 10 means "read it as base-10 decimal".
 * ============================================================================
 */

// `dotenv` lets you keep variables in a local file named `.env` during
// development (copy .env.example to .env and fill it in). `dotenv.config()`
// reads that file and copies its values into `process.env`.
// On Railway there is no .env file — the platform sets the variables itself,
// and this call simply finds nothing to load. It never overwrites a variable
// that's already set.
import dotenv from 'dotenv';

dotenv.config();

// The single, exported settings object. Pattern used for each line:
//     NAME: process.env.NAME || 'default'
// `||` means "use the left side if it has a value, otherwise the right side",
// so the default kicks in whenever the variable is missing or empty.
export const env = {
  // 'development' on your laptop, 'production' when deployed. Code can use
  // this to behave differently (e.g. more verbose errors in development).
  NODE_ENV: process.env.NODE_ENV || 'development',

  // The network port the web server listens on. Railway sets PORT for you.
  PORT: parseInt(process.env.PORT || '3000', 10),

  // Full connection address of the Postgres database, in the form
  //   postgresql://USER:PASSWORD@HOST:PORT/DATABASE_NAME
  // REQUIRED — checked at the bottom of this file.
  DATABASE_URL: process.env.DATABASE_URL || '',

  // Secret used to SIGN login tokens (JWTs). Anyone who knows it could forge
  // a login for any user, so it must be long, random, and never committed.
  // REQUIRED — checked at the bottom of this file.
  JWT_SECRET: process.env.JWT_SECRET || '',

  // ---- Cloud accounts -----------------------------------------------------
  // None here: each user adds their own cloud keys on the Config page (stored
  // encrypted in the database, see CREDENTIALS_ENCRYPTION_KEY below).

  // ---- Encrypting users' cloud keys --------------------------------------
  // Master key used to encrypt every user's cloud credentials before they
  // are stored (see src/services/CredentialService.ts). Any long random
  // string works (32+ characters), e.g. the output of: openssl rand -hex 32
  // ⚠️ If you change or lose it, stored credentials can no longer be
  // decrypted and every user must add their keys again. Without it, adding
  // credentials is refused with a clear message.
  CREDENTIALS_ENCRYPTION_KEY: process.env.CREDENTIALS_ENCRYPTION_KEY || '',

  // ---- Public addresses (needed for Google / Apple sign-in) --------------
  // FRONTEND_URL: where the website lives, e.g. https://cloudgaming.vercel.app
  //   Used to send people back after signing in with Google/Apple, and (if
  //   set) to restrict which website may call this API (CORS).
  // API_PUBLIC_URL: this backend's public address INCLUDING /api, e.g.
  //   https://cloudgaming-production.up.railway.app/api — Google and Apple
  //   redirect back to <API_PUBLIC_URL>/auth/oauth/<provider>/callback.
  FRONTEND_URL: (process.env.FRONTEND_URL || '').replace(/\/+$/, ''),
  API_PUBLIC_URL: (process.env.API_PUBLIC_URL || '').replace(/\/+$/, ''),

  // ---- "Continue with Google" (optional) ----------------------------------
  // From Google Cloud console → APIs & Services → Credentials → OAuth client
  // ID (type "Web application"). The button only appears when both are set.
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',

  // ---- "Continue with Apple" (optional) -----------------------------------
  // From developer.apple.com → Certificates, Identifiers & Profiles:
  //   APPLE_CLIENT_ID   the Services ID (e.g. com.example.cloudgaming.web)
  //   APPLE_TEAM_ID     your 10-character Team ID
  //   APPLE_KEY_ID      the Key ID of a "Sign in with Apple" key
  //   APPLE_PRIVATE_KEY the contents of that key's .p8 file (newlines may be
  //                     written as \n)
  // The button only appears when all four are set.
  APPLE_CLIENT_ID: process.env.APPLE_CLIENT_ID || '',
  APPLE_TEAM_ID: process.env.APPLE_TEAM_ID || '',
  APPLE_KEY_ID: process.env.APPLE_KEY_ID || '',
  APPLE_PRIVATE_KEY: (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),

  // ---- Logging -----------------------------------------------------------
  // Intended to control how chatty logs are. Currently only printed at
  // startup; nothing filters log output by it yet.
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

// ---------------------------------------------------------------------------
// FAIL FAST on missing required settings.
// This code runs the moment any file imports env.ts (i.e. at startup).
// `throw new Error(...)` stops the whole program with that message — which is
// exactly the "Missing required environment variable: DATABASE_URL" error you
// saw in the Railway logs before the variable was set.
// ---------------------------------------------------------------------------
const requiredEnvs = ['DATABASE_URL', 'JWT_SECRET'];
for (const key of requiredEnvs) {
  // `process.env[key]` looks the variable up by the name stored in `key`.
  // `!value` is true when it's missing (undefined) or an empty string.
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

// Warn (don't stop) about weak or missing secrets, so they show in the
// Railway logs. The values themselves are never printed.
if (env.JWT_SECRET.length < 32) {
  console.warn('[security] JWT_SECRET is shorter than 32 characters — use a long random value (openssl rand -hex 32). Changing it signs everyone out once.');
}
if (!env.CREDENTIALS_ENCRYPTION_KEY) {
  console.warn('[security] CREDENTIALS_ENCRYPTION_KEY is not set — saving cloud keys and launching machines will be refused until it is.');
} else if (env.CREDENTIALS_ENCRYPTION_KEY === env.JWT_SECRET) {
  console.warn('[security] CREDENTIALS_ENCRYPTION_KEY is the same as JWT_SECRET — use two different random values.');
}
