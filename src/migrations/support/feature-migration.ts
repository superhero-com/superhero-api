import { MigrationExecutor, MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Prior releases recorded each change separately. Keep those rows so adopting
 * a feature never replays existing DDL or rolls back schema it inherited.
 * TypeORM runs the pending changes and records the feature in one transaction.
 */
export abstract class FeatureMigration implements MigrationInterface {
  abstract readonly changes: Readonly<Record<string, MigrationInterface>>;

  private async pendingChanges(
    runner: QueryRunner,
  ): Promise<MigrationInterface[]> {
    const history = await new MigrationExecutor(
      runner.connection,
      runner,
    ).getExecutedMigrations();
    const applied = new Set(history.map((migration) => migration.name));
    return Object.entries(this.changes)
      .filter(([previousName]) => !applied.has(previousName))
      .map(([, change]) => change);
  }

  async up(runner: QueryRunner): Promise<void> {
    for (const change of await this.pendingChanges(runner))
      await change.up(runner);
  }

  async down(runner: QueryRunner): Promise<void> {
    const changes = await this.pendingChanges(runner);
    for (const change of changes.reverse()) await change.down(runner);
  }
}
