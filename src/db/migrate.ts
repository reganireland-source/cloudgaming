/**
 * ============================================================================
 * src/db/migrate.ts — CREATES AND UPDATES THE DATABASE TABLES
 * ============================================================================
 *
 * WHAT A "MIGRATION" IS
 * ---------------------
 * A database starts empty. Tables (users, machines, snapshots...) must be
 * created, and as the app grows, tables need new columns. Each such change
 * is written as a .sql file called a MIGRATION. Running migrations brings any
 * database — a fresh one or an old one — up to the current structure.
 *
 * WHERE THE SQL LIVES
 * -------------------
 *   database/schema.sql        the original full set of tables (runs first)
 *   database/migrations/*.sql  later changes, run in filename order
 *                              (003_..., 004_..., 005_...)
 *
 * HOW WE AVOID RUNNING THINGS TWICE: THE LEDGER
 * ---------------------------------------------
 * We keep a table called `schema_migrations` that records the name of every
 * file already applied. Each run checks the ledger and SKIPS anything it's
 * already done. That makes this script safe to run on every deploy — which
 * is exactly what happens: `npm start` runs this before starting the server.
 *
 * HOW IT'S RUN
 * ------------
 *   Production (Railway): automatically, via `npm start`.
 *   Manually:             `npm run migrate`     (uses the compiled dist/ file)
 *   Local development:    `npm run migrate:dev` (runs the .ts file directly)
 * ============================================================================
 */

// Node's built-in modules for reading files (fs = "file system") and for
// building file paths that work on any operating system (path).
import fs from 'fs';
import path from 'path';
import pool, { query, closePool } from '../config/database';

/**
 * Make sure the ledger table exists. `CREATE TABLE IF NOT EXISTS` does
 * nothing if it's already there, so this is harmless to call every time.
 */
async function ensureLedger(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Ask the ledger: has the file with this name been applied before?
 * Returns true if a matching row exists.
 */
async function alreadyApplied(name: string): Promise<boolean> {
  const result = await query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
  return result.rows.length > 0;
}

/**
 * Apply one .sql file INSIDE A TRANSACTION.
 *
 * A transaction is an all-or-nothing wrapper:
 *   BEGIN    — start collecting changes
 *   COMMIT   — make every change permanent at once
 *   ROLLBACK — throw every change away, as if nothing happened
 * If a file fails halfway through, ROLLBACK means we never end up with a
 * half-built table. We also record the file in the ledger inside the SAME
 * transaction, so "applied" and "recorded as applied" always match.
 *
 * @param name     the name to record in the ledger (e.g. "004_create_setup_status.sql")
 * @param filePath where the .sql file is on disk
 */
async function runFile(name: string, filePath: string): Promise<void> {
  // Read the entire file as text.
  const sql = fs.readFileSync(filePath, 'utf-8');

  // A transaction must stay on ONE connection, so borrow a dedicated one
  // instead of using the shared query() helper.
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(sql); // run every statement in the file
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
    console.log(`[migrate] Applied ${name}`);
  } catch (error) {
    // Something failed: undo everything this file did, then report which
    // file broke (the error ends the script with a failure code).
    await client.query('ROLLBACK');
    throw new Error(`[migrate] Failed applying ${name}: ${error}`);
  } finally {
    // `finally` runs whether we succeeded or failed — always hand the
    // connection back.
    client.release();
  }
}

/**
 * The main sequence: ledger -> base schema -> each migration in order.
 */
async function main(): Promise<void> {
  await ensureLedger();

  // `__dirname` is the folder THIS file is running from. After compiling,
  // that's dist/db/, so '../../database/schema.sql' climbs up two folders to
  // the project root, then into database/. (The .sql files deliberately live
  // outside src/ because the TypeScript compiler only copies .ts files into
  // dist/ — a .sql file inside src/ would be missing at runtime.)
  const schemaPath = path.join(__dirname, '../../database/schema.sql');

  // The base schema is recorded under the name "000_schema.sql" so it sorts
  // before every numbered migration.
  if (!(await alreadyApplied('000_schema.sql'))) {
    await runFile('000_schema.sql', schemaPath);
  } else {
    console.log('[migrate] Skipping 000_schema.sql (already applied)');
  }

  const migrationsDir = path.join(__dirname, '../../database/migrations');
  if (fs.existsSync(migrationsDir)) {
    // List the folder, keep only .sql files, and sort by name. The numeric
    // prefixes (003_, 004_...) are what make alphabetical order = run order.
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // `for ... of` with `await` inside runs the files ONE AT A TIME, in
    // order — important, since later migrations depend on earlier ones.
    for (const file of files) {
      if (await alreadyApplied(file)) {
        console.log(`[migrate] Skipping ${file} (already applied)`);
        continue; // jump to the next file
      }
      await runFile(file, path.join(migrationsDir, file));
    }
  }

  console.log('[migrate] Done');
}

// ---------------------------------------------------------------------------
// Run it. `.catch` handles any failure: print it and set a non-zero exit
// code (a non-zero exit code is how programs signal "I failed"; because
// `npm start` joins the steps with `&&`, the server then won't start on top
// of a half-migrated database). `.finally` always closes the database pool
// so the process can finish instead of hanging on open connections.
// ---------------------------------------------------------------------------
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
