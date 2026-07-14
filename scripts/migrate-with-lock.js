#!/usr/bin/env node
'use strict';

/**
 * Wraps `migration:run` with a Postgres session advisory lock so that
 * multiple replicas starting at once (rolling deploy, autoscaling) serialize
 * on the schema migration instead of racing DDL against each other. The
 * first replica to connect acquires the lock and runs the pending
 * migrations; every other replica blocks on the same lock and, once it
 * acquires it in turn, runs migration:run itself — which is then a no-op
 * because TypeORM has already recorded those migrations as applied.
 */

const { Client } = require('pg');
const { spawnSync } = require('child_process');

// Arbitrary fixed pair of int32 keys identifying this app's migration lock
// (the `pg_advisory_lock(int, int)` overload). Only their fixed, unique
// combination matters — they carry no other meaning.
const LOCK_KEY_1 = 0x53_75_70_45;
const LOCK_KEY_2 = 0x72_41_70_69;

async function main() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  await client.connect();
  try {
    // Blocks until no other replica running this script holds the lock.
    await client.query('SELECT pg_advisory_lock($1, $2)', [
      LOCK_KEY_1,
      LOCK_KEY_2,
    ]);

    const result = spawnSync(
      process.execPath,
      [
        './node_modules/typeorm/cli.js',
        'migration:run',
        '-d',
        'dist/data-source.js',
      ],
      { stdio: 'inherit' },
    );

    process.exitCode = result.status ?? 1;
  } finally {
    // Best-effort cleanup: `pg_advisory_lock` is session-scoped, so it is
    // released automatically once this connection closes even if the
    // explicit unlock (or the close itself) fails. A cleanup failure here
    // must never override the exit code the migration itself already set —
    // otherwise a successful migration gets reported as a failure and the
    // Docker `migrate && start` chain never reaches `start:prod`, even
    // though the schema change already landed.
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        LOCK_KEY_1,
        LOCK_KEY_2,
      ]);
    } catch (error) {
      console.error(
        '[migrate-with-lock] failed to release advisory lock (released automatically when the connection closes)',
        error,
      );
    }
    try {
      await client.end();
    } catch (error) {
      console.error(
        '[migrate-with-lock] failed to close db connection cleanly',
        error,
      );
    }
  }
}

main().catch((error) => {
  console.error('[migrate-with-lock] failed', error);
  process.exitCode = 1;
});
