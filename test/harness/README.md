# TGR test harness

Shared infrastructure for Token-Gated-Rooms (TGR) integration specs. Provides
**hermetic DB isolation** and a **relay reachability fixture** so integration
specs don't contend on the shared local Postgres / relay.

## What lives here

| File | Purpose |
|---|---|
| `db.ts` | DB isolation helpers — a throwaway **database** per run (`createIsolatedDatabase`) and a throwaway **schema** per run (`createIsolatedSchema`). |
| `relay.ts` | Local relay fixture — `relayReachable()` probe + the relay-admin keypair (`RELAY_ADMIN_NSEC`) + default `RELAY_URL`, so relay-backed specs auto-skip when no relay is up. |

Self-tests proving these work live in the unit project so they always run:
`src/token-gated-rooms/__tests__/harness-db.integration.spec.ts` and
`src/token-gated-rooms/__tests__/harness-relay.spec.ts`.

## DB isolation — two patterns, pick by what you test

### 1. Throwaway database — for migration specs (`createIsolatedDatabase`)

The TGR migrations **hard-code the `"public"` schema** (e.g.
`CREATE TYPE "public"."token_nostr_room_state_enum"`,
`DROP INDEX "public"."idx_..."`) and `ALTER TABLE "token"` resolves `token` via
the connection `search_path`. So a *dedicated non-`public` schema* is **not** a
sufficient sandbox — the enum types and `"public".*` references would still land
in (and collide with) the shared `public` schema, and a left-behind migrations
history row or half-reverted index makes the spec non-deterministic.

A **fresh database** has its own private `public` schema, so every migration
object is naturally scoped to the run and the real `migration:run`/`revert` path
can be exercised repeatedly and concurrently without touching the dev DB:

```ts
import { createIsolatedDatabase, MINIMAL_TOKEN_TABLE_SQL } from '@/test/harness/db';

let db;
beforeAll(async () => {
  db = await createIsolatedDatabase({
    entities: [/* ... */],
    migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
    seedSql: [MINIMAL_TOKEN_TABLE_SQL], // migration #1 alters `token`
  });
  await db.dataSource.runMigrations();
});
afterAll(async () => { if (db) await db.drop(); }); // drops the whole DB
```

Used by `src/token-gated-rooms/entities/migrations.integration.spec.ts`.
`dropDatabase()` refuses to target the configured application database.

### 2. Throwaway schema — for service/controller specs (`createIsolatedSchema`)

Cheaper than a whole database. For specs that drive services/repositories (not
the migration SQL), `synchronize` the entities into a fresh schema:

```ts
import { createIsolatedSchema } from '@/test/harness/db';

const iso = await createIsolatedSchema({ entities: [CommunityRoom, RoomMembership /* ... */] });
// ... use iso.dataSource ...
await iso.drop(); // DROP SCHEMA ... CASCADE
```

This mirrors the inline `CREATE SCHEMA tgr13_test` pattern already in
`rooms.integration.spec.ts`. Do **not** use it for migration specs (see above).

## Relay fixture (`relay.ts`)

During local runs a NIP-29 relay (`groups_relay` / strfry29) listens at
`ws://localhost:7777` (override with `TG_RELAY_URL`). Relay-backed specs must
**auto-skip** when it is unreachable so no-container CI stays green:

```ts
import { relayReachable, RELAY_URL, RELAY_ADMIN_NSEC } from '@/test/harness/relay';

let relayUp = false;
beforeAll(async () => {
  relayUp = !!process.env.TG_RELAY_URL || (await relayReachable(RELAY_URL));
});
(relayUp ? it : it.skip)('publishes to the relay', async () => { /* ... */ });
```

`RELAY_ADMIN_NSEC` defaults to the `groups_relay/config/settings.test.yml`
relay-admin key (D7: the bot key under test == the relay admin, so it may create
managed groups on a freshly-booted relay). Override via `TG_BOT_NSEC`.

The existing relay-backed specs (`relay-subscriber`, `relay-writer`,
`room-admins`, `membership-sync`) already inline this auto-skip; they were left
as-is. New relay-backed specs should import from `relay.ts` instead of copying it.

## Commands

```sh
# Full TGR suite (unit + DB integration; relay cases auto-skip if no relay).
# Requires the local Postgres at $DB_HOST:$DB_PORT.
npx jest src/token-gated-rooms --runInBand

# Existing repo aliases:
npm test          # whole unit project (.spec.ts under src/)
npm run test:e2e  # the separate e2e project (test/jest-e2e.json)
```

## Env knobs

| Var | Default | Meaning |
|---|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_DATABASE` | repo `.env` | Test Postgres. DB-integration specs auto-skip when `DB_HOST` is unset. |
| `TG_TEST_DB_ADMIN_DATABASE` | `DB_DATABASE` | Maintenance DB used only to `CREATE`/`DROP` throwaway databases. |
| `TG_RELAY_URL` | `ws://localhost:7777` | Relay endpoint; setting it also forces relay-backed cases to run (vouched external relay). |
| `TG_BOT_NSEC` | `settings.test.yml` relay-admin nsec | Bot/relay-admin key for relay-backed specs. |

## Isolation guarantees

- `createIsolatedDatabase` never touches the shared application database; its
  objects live in a uniquely-named throwaway DB dropped on teardown.
- The migration spec is deterministic regardless of whether the shared `public`
  schema already has TGR objects (verified: a dirty `public` is left untouched).
- DB-integration and relay specs both auto-skip when their backing service is
  absent, so unit-only / CI-without-services runs stay green.
```
