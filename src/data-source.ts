import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { DATABASE_CONFIG } from './configs/database';

/**
 * TypeORM `DataSource` for the migration CLI (`migration:run`/`migration:revert`).
 *
 * Reuses {@link DATABASE_CONFIG} (the same connection the app uses) but:
 *   - forces `synchronize: false` — schema must come from migrations, never the
 *     destructive `synchronize` path (see `src/configs/database.ts`);
 *   - points `entities` at the same glob the app uses so `migration:generate`/diff
 *     sees the live entity definitions;
 *   - registers the ordered migration files + the `migrations` history table.
 *
 * Invoked via `typeorm-ts-node-commonjs -d src/data-source.ts` so `.ts` migrations
 * run without a build step.
 */
const AppDataSource = new DataSource({
  ...(DATABASE_CONFIG as DataSourceOptions),
  synchronize: false,
  entities: [__dirname + '/**/entities/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  migrationsTableName: 'migrations',
});

export default AppDataSource;
