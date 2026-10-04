import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

interface SqliteDatabase {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    get(...args: unknown[]): Record<string, string | number> | undefined;
    all(...args: unknown[]): Record<string, string | number>[];
    run(...args: unknown[]): unknown;
  };
}
// Node >=22.13 ships SQLite; the repository's older Node type package does not.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

export const SHORTS_DATA_DIR = resolve(
  process.env.SHORTS_DATA_DIR || '.shorts-testnet',
);
@Injectable()
export class ShortsStoreService implements OnModuleDestroy {
  readonly db: SqliteDatabase;
  constructor() {
    mkdirSync(SHORTS_DATA_DIR, { recursive: true, mode: 0o700 });
    const path = resolve(SHORTS_DATA_DIR, 'shorts.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, address TEXT NOT NULL, message TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connected_wallet_sessions (hash TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);`);
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
  onModuleDestroy() {
    this.db.close();
  }
}
