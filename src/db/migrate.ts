import fs from 'fs';
import path from 'path';
import pool, { query, closePool } from '../config/database';

/**
 * Runs src/db/schema.sql once, then every .sql file in database/migrations/
 * in filename order, skipping ones already recorded in schema_migrations.
 * Each file runs inside its own transaction.
 */
async function ensureLedger(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function alreadyApplied(name: string): Promise<boolean> {
  const result = await query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
  return result.rows.length > 0;
}

async function runFile(name: string, filePath: string): Promise<void> {
  const sql = fs.readFileSync(filePath, 'utf-8');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
    console.log(`[migrate] Applied ${name}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(`[migrate] Failed applying ${name}: ${error}`);
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  await ensureLedger();

  const schemaPath = path.join(__dirname, '../../database/schema.sql');
  if (!(await alreadyApplied('000_schema.sql'))) {
    await runFile('000_schema.sql', schemaPath);
  } else {
    console.log('[migrate] Skipping 000_schema.sql (already applied)');
  }

  const migrationsDir = path.join(__dirname, '../../database/migrations');
  if (fs.existsSync(migrationsDir)) {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (await alreadyApplied(file)) {
        console.log(`[migrate] Skipping ${file} (already applied)`);
        continue;
      }
      await runFile(file, path.join(migrationsDir, file));
    }
  }

  console.log('[migrate] Done');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
