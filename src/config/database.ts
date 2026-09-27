/**
 * ============================================================================
 * src/config/database.ts — HOW THE APP TALKS TO POSTGRES
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Sets up the connection to the PostgreSQL database and exports a small
 * `query()` helper that every other file uses to run SQL.
 *
 * KEY IDEA: A CONNECTION POOL
 * ---------------------------
 * Opening a brand-new database connection is slow (a network handshake plus
 * a login). A POOL opens a handful of connections and keeps them ready.
 * Each query borrows a connection, runs, and hands it back for reuse — like
 * a car-hire desk lending out cars instead of building a new car per trip.
 *
 * KEY IDEA: PARAMETERISED QUERIES (security!)
 * -------------------------------------------
 * Callers write SQL with numbered placeholders and pass values separately:
 *     query('SELECT * FROM machines WHERE id = $1', [machineId])
 * The database driver inserts the values SAFELY. Never build SQL by gluing
 * user input into the string (`... WHERE id = '` + id + `'`) — that allows
 * "SQL injection", where a malicious value rewrites your query.
 * ============================================================================
 */

// `pg` is the standard PostgreSQL driver for Node.js.
//   Pool       = the connection pool described above.
//   PoolClient = one borrowed connection (used when we need several queries
//                on the SAME connection, e.g. inside a transaction).
import { Pool, PoolClient } from 'pg';
import { env } from './env';

// Create the pool once when this file is first imported. Every import of
// this module shares this same pool object.
const pool = new Pool({
  connectionString: env.DATABASE_URL, // where the database is and how to log in
  max: 20,                            // at most 20 connections open at once
  idleTimeoutMillis: 30000,           // close a connection unused for 30 s
  connectionTimeoutMillis: 2000,      // give up if a connection can't be made in 2 s
});

// If an idle pooled connection breaks unexpectedly (e.g. the database
// restarted), `pg` emits an 'error' event. We log it and exit the process
// with a failure code. That sounds drastic, but on Railway a crashed process
// is automatically restarted, which re-creates a clean pool — better than
// limping along with a broken one.
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

/**
 * Run one SQL statement and return the result.
 *
 * @param text   The SQL, using $1, $2, ... as placeholders for values.
 * @param params The values for those placeholders, in order.
 * @returns      A result object; the returned rows are in `result.rows`
 *               (an array of plain objects keyed by column name).
 *
 * Example:
 *   const result = await query('SELECT * FROM users WHERE email = $1', [email]);
 *   const user = result.rows[0]; // undefined if no match
 *
 * `async` means this function returns a Promise (a value that arrives later),
 * so callers must `await` it.
 */
export async function query(text: string, params?: unknown[]) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);

    // Warn about anything slower than 1 second so performance problems show
    // up in the logs early.
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`slow query (${duration}ms): ${text}`);
    }
    return result;
  } catch (error) {
    // Log WHICH query failed (very useful when debugging), then re-throw so
    // the caller still knows it failed and can respond with an error.
    console.error('Database query error:', text, error);
    throw error;
  }
}

/**
 * Borrow a single dedicated connection from the pool.
 * Use this when several statements must run on the SAME connection — most
 * commonly a TRANSACTION (BEGIN ... COMMIT), where all changes succeed
 * together or are all undone together.
 * IMPORTANT: always call `client.release()` when finished (in a `finally`
 * block), or the pool slowly runs out of connections.
 */
export async function getClient(): Promise<PoolClient> {
  return pool.connect();
}

/**
 * Close every connection in the pool. Used by short-lived scripts (like the
 * migration runner) so the process can exit cleanly instead of hanging
 * with open connections.
 */
export async function closePool() {
  await pool.end();
}

// Also export the pool itself for code that needs lower-level access.
export default pool;
