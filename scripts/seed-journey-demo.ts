/**
 * LOCAL DEMO ONLY: fills `journey_events` with synthetic journeys so the
 * "User journey" dashboard has something to show on a developer machine.
 *
 * Every id is a fresh random UUID and every page is a route pattern; no real
 * user data is involved. Refuses to run with NODE_ENV=production.
 *
 *   DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=postgres DB_DATABASE=bcl_api \
 *     npx ts-node -r tsconfig-paths/register scripts/seed-journey-demo.ts [browsers]
 *
 * Pass `--clear` to only delete the demo rows (truncates the table).
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

if (process.env.NODE_ENV === 'production') {
  console.error('seed-journey-demo is for local databases only.');
  process.exit(1);
}

type Row = { anon_id: string; event: string; page: string; occurred_at: Date };

const PAGES = [
  '/',
  '/trends',
  '/trends/tokens',
  '/trends/tokens/:tokenName',
  '/users/:address',
  '/defi/swap',
  '/defi/pool',
  '/post/:postId',
  '/trends/create',
];

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function chance(p: number): boolean {
  return Math.random() < p;
}

function journey(start: number): Row[] {
  const anon = randomUUID();
  const rows: Row[] = [];
  let t = start;
  const step = (
    event: string,
    page: string,
    gapSec = 5 + Math.random() * 90,
  ) => {
    t += gapSec * 1000;
    rows.push({ anon_id: anon, event, page, occurred_at: new Date(t) });
  };

  // A short browse first.
  const browse = 1 + Math.floor(Math.random() * 4);
  for (let i = 0; i < browse; i++) {
    step('page_view', pick(PAGES));
  }

  // Onboarding flow, with realistic drop-off at each step.
  if (chance(0.55)) {
    step('page_view', '/users/:address');
    step('profile_view', '/users/:address', 1);
    if (chance(0.62)) {
      step('profile_edit_open', '/users/:address');
      if (chance(0.45)) {
        step('claim_account_open', '/users/:address');
        if (chance(0.8)) step('claim_account_done', '/users/:address', 40);
        if (chance(0.7)) {
          step('x_connect_start', '/users/:address');
          if (chance(0.66)) {
            step('x_connected', '/users/:address', 30);
            if (chance(0.5)) {
              step('page_view', '/');
              step('post_created', '/', 120);
              if (chance(0.2)) {
                step('page_view', '/trends/create');
                step('token_created', '/trends/create', 200);
              }
            }
          }
        }
      }
    }
  }

  // Wallet flow.
  if (chance(0.4)) {
    step('wallet_connect_open', pick(PAGES));
    if (chance(0.7)) {
      step('wallet_connected', pick(PAGES), 20);
      if (chance(0.3)) step('post_created', '/', 300);
    }
  }

  // Trading.
  if (chance(0.45)) {
    step('page_view', '/trends/tokens/:tokenName');
    step('token_view', '/trends/tokens/:tokenName', 1);
    if (chance(0.35)) {
      step('token_buy_done', '/trends/tokens/:tokenName', 60);
      if (chance(0.4))
        step('token_sell_done', '/trends/tokens/:tokenName', 900);
    }
  }

  // Finish with a page or two, sometimes after a long gap (a new visit).
  if (chance(0.3)) step('page_view', pick(PAGES), 45 * 60);
  if (chance(0.5)) step('page_view', pick(PAGES));
  return rows;
}

async function main() {
  const clear = process.argv.includes('--clear');
  const browsers = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 1500);
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });
  await ds.initialize();
  try {
    await ds.query('TRUNCATE journey_events');
    if (clear) {
      console.log('journey_events cleared');
      return;
    }
    const now = Date.now();
    const rows: Row[] = [];
    for (let i = 0; i < browsers; i++) {
      const start = now - Math.random() * 28 * 24 * 3600 * 1000;
      rows.push(...journey(start).filter((r) => r.occurred_at.getTime() < now));
    }
    for (let i = 0; i < rows.length; i += 2000) {
      await ds
        .createQueryBuilder()
        .insert()
        .into('journey_events', ['anon_id', 'event', 'page', 'occurred_at'])
        .values(rows.slice(i, i + 2000))
        .execute();
    }
    console.log(
      `inserted ${rows.length} synthetic events for ${browsers} browsers`,
    );
  } finally {
    await ds.destroy();
  }
}

void main();
