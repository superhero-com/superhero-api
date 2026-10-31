import { Injectable, OnApplicationShutdown, Optional } from '@nestjs/common';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';

interface SqliteDatabase {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    get(...args: unknown[]): Record<string, string | number> | undefined;
    all(...args: unknown[]): Record<string, string | number>[];
    run(...args: unknown[]): unknown;
  };
}
export const SHORTS_DATA_DIR = resolve(
  process.env.SHORTS_DATA_DIR || '.shorts-testnet',
);
@Injectable()
export class ShortsStoreService implements OnApplicationShutdown {
  private database?: SqliteDatabase;
  readonly shared: boolean;
  private closed = false;
  constructor(@Optional() source?: DataSource) {
    this.shared = !!source;
    if (this.shared) {
      if (
        process.env.SHORTS_DATA_DIR ||
        ['CONTENT', 'ANALYTICS', 'RECEIPTS'].some(
          (kind) => process.env[`SHORTS_IMPORT_LEGACY_${kind}`] === '1',
        )
      )
        throw new Error(
          'Hosted Shorts use shared storage. Complete the offline legacy migration, then remove SHORTS_DATA_DIR and legacy import flags from the API environment.',
        );
      return;
    }
    // SQLite is loaded only by the loopback demo or explicit offline migrator.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    mkdirSync(SHORTS_DATA_DIR, { recursive: true, mode: 0o700 });
    const path = resolve(SHORTS_DATA_DIR, 'shorts.sqlite');
    const db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      // The in-memory snapshot has exactly one owner. Hold the database's
      // OS-backed lock across commits; a paused process must never lose it to
      // a time-based lease. WAL commits remain durable on this connection.
      db.exec(`PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      BEGIN EXCLUSIVE; COMMIT;
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, address TEXT NOT NULL, message TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connected_wallet_sessions (hash TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);`);
    } catch (error) {
      db.close();
      if ([5, 6].includes((error as { errcode?: number }).errcode ?? 0))
        throw new Error(
          'Shorts data store is already in use. Stop the existing Shorts API before starting another instance.',
        );
      throw error;
    }
    this.database = db;
  }
  get db(): SqliteDatabase {
    if (!this.database)
      throw new Error('Local Shorts storage is unavailable in the hosted API');
    return this.database;
  }
  load() {
    const row = this.db.prepare('SELECT body FROM state WHERE id=1').get();
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  save(state: unknown) {
    this.db
      .prepare(
        'INSERT INTO state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(
        JSON.stringify(state, (_, value) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      );
  }
  onApplicationShutdown() {
    // Run after background workers and HTTP requests have drained, so a new
    // owner cannot start while the old process still has work in flight.
    if (this.closed) return;
    this.database?.close();
    this.closed = true;
  }
}
