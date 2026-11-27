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
  const timestamp = Number(file.slice(0, 13));
  const steps = migration.steps ?? { [Migration.name.replace(/\d{13}$/, '')]: migration };
  for (const [offset, [key, change]] of Object.entries(steps).entries()) {
    const name = key + (timestamp + offset);
    if (Object.hasOwn(schemaMigrations, key)) throw new Error('Duplicate test schema change: ' + key);
    // TypeORM requires a timestamp when a fixture runs an isolated schema step.
    schemaMigrations[key] = class SchemaStep {
      name = name;
      up(runner) { return change.up(runner); }
      down(runner) { return change.down(runner); }
    };
  }
}
module.exports = schemaMigrations;
