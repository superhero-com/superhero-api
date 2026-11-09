import { MigrationInterface, QueryRunner } from 'typeorm';

export abstract class FeatureMigration implements MigrationInterface {
  abstract readonly steps: Readonly<Record<string, MigrationInterface>>;

  async up(runner: QueryRunner): Promise<void> {
    for (const change of Object.values(this.steps)) await change.up(runner);
  }

  async down(runner: QueryRunner): Promise<void> {
    const steps = Object.values(this.steps);
    for (const change of steps.reverse()) await change.down(runner);
  }
}
