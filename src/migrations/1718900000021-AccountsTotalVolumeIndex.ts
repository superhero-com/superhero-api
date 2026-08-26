import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `accounts` had no index beyond its primary key, so the list endpoint's
 * default sort (`order_by=total_volume`) scanned and sorted the whole table.
 * At the current 3.5k rows that is only 1.21ms -> 0.055ms and the index is
 * 128kB -- it earns its keep as the table grows, not today.
 *
 * Plain CREATE INDEX for the reason PostsTokenMentionsGinIndex1718900000016
 * explains.
 */
export class AccountsTotalVolumeIndex1718900000021 implements MigrationInterface {
  name = 'AccountsTotalVolumeIndex1718900000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ACCOUNTS_TOTAL_VOLUME" ON "accounts" ("total_volume")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_ACCOUNTS_TOTAL_VOLUME"`,
    );
  }
}
