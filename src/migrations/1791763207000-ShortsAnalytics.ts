import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsAnalytics1791763207000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE shorts_measurement_settings (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      salt char(64) NOT NULL CHECK(salt ~ '^[a-f0-9]{64}$'), since bigint NOT NULL CHECK(since>=0),
      legacy_hash char(64), PRIMARY KEY(network,contract),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract)
    )`);
    await runner.query(`CREATE TABLE shorts_measurement_viewers (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, viewer char(64) NOT NULL,
      touched bigint NOT NULL, forgotten_until bigint NOT NULL DEFAULT 0,
      PRIMARY KEY(network,contract,viewer),
      FOREIGN KEY(network,contract) REFERENCES shorts_measurement_settings(network,contract),
      CHECK(viewer ~ '^[a-f0-9]{64}$' AND touched>=0 AND forgotten_until>=0)
    )`);
    await runner.query(`CREATE TABLE shorts_measurement_plays (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, id varchar(80) NOT NULL,
      short_id varchar(80) NOT NULL, viewer char(64) NOT NULL,
      started bigint NOT NULL CHECK(started>=0), day bigint NOT NULL CHECK(day=started/86400000),
      seconds double precision NOT NULL CHECK(seconds>=0 AND seconds<=duration),
      duration double precision NOT NULL CHECK(duration BETWEEN 2 AND 60),
      source varchar(16) NOT NULL CHECK(source IN ('for-you','following','recent','saved','shared')),
      PRIMARY KEY(network,contract,id), UNIQUE(network,contract,viewer,short_id,day),
      FOREIGN KEY(network,contract,short_id) REFERENCES shorts_content(network,contract,id),
      FOREIGN KEY(network,contract,viewer) REFERENCES shorts_measurement_viewers(network,contract,viewer)
    )`);
    await runner.query(`CREATE INDEX shorts_measurement_period ON shorts_measurement_plays(network,contract,started);
      CREATE INDEX shorts_measurement_video ON shorts_measurement_plays(network,contract,short_id,started);
      CREATE INDEX shorts_measurement_viewer ON shorts_measurement_plays(network,contract,viewer,started);
      CREATE INDEX shorts_measurement_viewer_expiry ON shorts_measurement_viewers(network,contract,touched)`);
    await runner.query(`CREATE TABLE shorts_measurement_totals (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, short_id varchar(80) NOT NULL,
      views bigint NOT NULL CHECK(views>=0), PRIMARY KEY(network,contract,short_id),
      FOREIGN KEY(network,contract,short_id) REFERENCES shorts_content(network,contract,id)
    )`);
  }
  async down(runner: QueryRunner): Promise<void> {
    // Privacy history must not disappear through an ordinary schema rollback.
    const [{ n }] = await runner.query(
      'SELECT count(*)::integer AS n FROM shorts_measurement_settings',
    );
    if (n)
      throw new Error(
        'Restore/reconcile measurement data before removing its schema',
      );
    await runner.query('DROP TABLE shorts_measurement_totals');
    await runner.query('DROP TABLE shorts_measurement_plays');
    await runner.query('DROP TABLE shorts_measurement_viewers');
    await runner.query('DROP TABLE shorts_measurement_settings');
  }
}
