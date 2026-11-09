// Some fixtures deliberately exercise an intermediate schema or the rollback
// of an individual change. Use the same SQL as the TypeORM feature migrations.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');

const compiled = process.env.SHORTS_TEST_COMPILED === '1';
const directory = join(__dirname, '../../..', compiled ? 'dist' : 'src', 'migrations');
const suffix = compiled ? '.js' : '.ts';
const schemaMigrations = {};
for (const file of readdirSync(directory)) {
  if (!/^\d+-(Shorts|ProfileAndPostMedia)/.test(file) || !file.endsWith(suffix) || file.endsWith('.d.ts')) continue;
  const [Migration] = Object.values(require(join(directory, file)));
  const migration = new Migration();
  for (const [name, change] of Object.entries(migration.changes ?? { [Migration.name]: migration })) {
    const key = name.replace(/\d{13}$/, '');
    if (Object.hasOwn(schemaMigrations, key)) throw new Error('Duplicate test schema change: ' + key);
    // Partial-upgrade fixtures also pass these constructors to DataSource.
    schemaMigrations[key] = class HistoricalMigration {
      name = name;
      up(runner) { return change.up(runner); }
      down(runner) { return change.down(runner); }
    };
  }
}
module.exports = schemaMigrations;
