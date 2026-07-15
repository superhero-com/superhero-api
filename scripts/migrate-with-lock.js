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
 *
 * The lock is session-scoped (`pg_advisory_lock`) and TypeORM runs the
 * migration in a SEPARATE process on its OWN connection, so the lock-holding
 * connection here sits idle for the whole migration. If that idle connection
 * is closed — a managed-Postgres `idle_session_timeout`, a connection pooler,
 * or an idle-TCP middlebox — the lock is silently released and another replica
 * can acquire it and migrate concurrently. To prevent that we keep this
 * session from ever being idle: TCP keepalives at the socket layer, a periodic
 * lightweight ping so the server never sees an idle session, and disabling the
 * server-side idle-session reaper for this session.
 */

const { Client } = require('pg');
const { spawn } = require('child_process');

// Arbitrary fixed pair of int32 keys identifying this app's migration lock
// (the `pg_advisory_lock(int, int)` overload). Only their fixed, unique
// combination matters — they carry no other meaning.
const LOCK_KEY_1 = 0x53_75_70_45;
const LOCK_KEY_2 = 0x72_41_70_69;

// How often to ping the lock-holding session so it never sits idle long enough
// for a server or middlebox idle timeout to reap it. Comfortably below the
// idle timeouts seen on managed Postgres / poolers (typically >= 60s).
const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Run TypeORM's migration in a child process. Uses async `spawn` (not the
 * blocking `spawnSync`) so the event loop stays free to fire keepalive pings
 * on the lock-holding connection while the migration runs.
 */
function runMigration() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        './node_modules/typeorm/cli.js',
        'migration:run',
        '-d',
        'dist/data-source.js',
      ],
      { stdio: 'inherit' },
    );
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      console.error(
        '[migrate-with-lock] failed to spawn migration process',
        error,
      );
      resolve(1);
    });
  });
}

async function main() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    // Socket-level keepalives stop NAT/load-balancer middleboxes from dropping
    // the (otherwise idle) connection while the migration runs.
    keepAlive: true,
  });

  await client.connect();

  let keepAliveTimer = null;
  try {
    // Blocks until no other replica running this script holds the lock. The
    // session is "active" (waiting on the lock) here, not idle, so the reaper
    // concerns below only apply once we own the lock and the migration starts.
    await client.query('SELECT pg_advisory_lock($1, $2)', [
      LOCK_KEY_1,
      LOCK_KEY_2,
    ]);

    // Belt-and-suspenders alongside the pings: turn off the server's
    // idle-session reaper for this one session. Ignored where the GUC does not
    // exist (Postgres < 14) or cannot be set — the pings remain the primary
    // defense.
    try {
      await client.query('SET idle_session_timeout = 0');
    } catch (error) {
      console.error(
        '[migrate-with-lock] could not disable idle_session_timeout; relying on keepalive pings',
        error,
      );
    }

    // Keep the lock-holding session from ever being idle. A failed ping means
    // the connection (and thus the advisory lock) may have been lost — log it
    // loudly, but do not touch the migration's exit code.
    keepAliveTimer = setInterval(() => {
      client.query('SELECT 1').catch((error) => {
        console.error(
          '[migrate-with-lock] keepalive ping failed — the advisory lock may have been lost, risking a concurrent migration',
          error,
        );
      });
    }, KEEPALIVE_INTERVAL_MS);
    // Don't let the keepalive timer itself keep the process alive.
    if (typeof keepAliveTimer.unref === 'function') {
      keepAliveTimer.unref();
    }

    process.exitCode = await runMigration();
  } finally {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
    }
    // Best-effort cleanup: `pg_advisory_lock` is session-scoped, so it is
    // released automatically once this connection closes even if the
    // explicit unlock (or the close itself) fails. A cleanup failure here
    // must never override the exit code the migration itself already set —
    // otherwise a successful migration gets reported as a failure and the
    // Docker `migrate && start` chain never reaches `start:prod`, even
    // though the schema change already landed.
    try {
      const unlock = await client.query(
        'SELECT pg_advisory_unlock($1, $2) AS released',
        [LOCK_KEY_1, LOCK_KEY_2],
      );
      // `released` is false when this session did NOT hold the lock at unlock
      // time — i.e. it was reset mid-migration and the protection lapsed.
      if (unlock.rows[0] && unlock.rows[0].released === false) {
        console.error(
          '[migrate-with-lock] advisory lock was not held at unlock time — the session may have been reset mid-migration, so a concurrent migration was possible',
        );
      }
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
