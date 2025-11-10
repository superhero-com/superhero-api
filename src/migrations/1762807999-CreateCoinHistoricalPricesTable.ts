import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateCoinHistoricalPricesTable1234567890 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'coin_historical_prices',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'coin_id',
            type: 'varchar',
            length: '50',
          },
          {
            name: 'currency',
            type: 'varchar',
            length: '10',
          },
          {
            name: 'timestamp_ms',
            type: 'bigint',
          },
          {
            name: 'price',
            type: 'decimal',
            precision: 20,
            scale: 8,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP(6)',
          },
        ],
      }),
      true,
    );

    // Create composite index for efficient lookups
    await queryRunner.createIndex(
      'coin_historical_prices',
      new TableIndex({
        name: 'IDX_COIN_CURRENCY_TIMESTAMP',
        columnNames: ['coin_id', 'currency', 'timestamp_ms'],
      }),
    );

    // Create index on timestamp for time-range queries
    await queryRunner.createIndex(
      'coin_historical_prices',
      new TableIndex({
        name: 'IDX_TIMESTAMP',
        columnNames: ['timestamp_ms'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('coin_historical_prices', 'IDX_TIMESTAMP');
    await queryRunner.dropIndex('coin_historical_prices', 'IDX_COIN_CURRENCY_TIMESTAMP');
    await queryRunner.dropTable('coin_historical_prices');
  }
}

