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

  // ---- Cloud providers --------------------------------------------------
  // Default AWS region: Singapore, the primary region for this project.
  AWS_REGION: process.env.AWS_REGION || 'ap-southeast-1',
  AZURE_SUBSCRIPTION_ID: process.env.AZURE_SUBSCRIPTION_ID || '',
  // Legacy/unused for launching: each user now adds their own Google Cloud
  // project + key on the Config page (stored encrypted in the database).
  GCP_PROJECT_ID: process.env.GCP_PROJECT_ID || '',

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

  // ---- Gaming machine image ---------------------------------------------
  // An AMI ("Amazon Machine Image") is a saved disk template that new AWS
  // servers boot from. Ours is built with Packer (infrastructure/packer/)
  // and has GPU drivers + Sunshine pre-installed, so machines start faster.
  // The default here is only a placeholder — set your real AMI ID.
  CLOUDGAMING_AMI_ID: process.env.CLOUDGAMING_AMI_ID || 'ami-0c55b159cbfafe1f0',

  // ---- SSH settings used by CloudyPadSetup ------------------------------
  // SSH is a secure remote command line. After launching a Windows gaming
  // machine, the backend SSHes into it to finish configuring it.
  // Path to the PRIVATE KEY file that proves who we are to that machine.
  SSH_KEY_PATH: process.env.SSH_KEY_PATH || '/root/.ssh/cloudgaming-key.pem',
  // Windows' built-in admin account name.
  SSH_USERNAME: process.env.SSH_USERNAME || 'Administrator',
  // How long to keep trying before giving up (300000 ms = 5 minutes).
  SSH_TIMEOUT_MS: parseInt(process.env.SSH_TIMEOUT_MS || '300000', 10), // 5 minutes
  // How long to wait between attempts while the machine is still booting.
  SSH_RETRY_DELAY_MS: parseInt(process.env.SSH_RETRY_DELAY_MS || '10000', 10), // 10 seconds

  // ---- Email (for future alerts; not wired up yet) ----------------------
  MAIL_SERVICE: process.env.MAIL_SERVICE || 'smtp',
  MAIL_FROM: process.env.MAIL_FROM || 'noreply@cloudgaming.dev',

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
