import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsSessions1791763201000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE shorts_auth_scopes (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, origin varchar(256) NOT NULL,
      PRIMARY KEY(network,contract,origin)
    )`);
    await runner.query(`CREATE TABLE shorts_auth_challenges (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, origin varchar(256) NOT NULL,
      id char(48) NOT NULL, address varchar(100) NOT NULL, message varchar(2048) NOT NULL,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY(network,contract,origin,id),
      FOREIGN KEY(network,contract,origin) REFERENCES shorts_auth_scopes(network,contract,origin)
    )`);
    await runner.query(`CREATE INDEX shorts_auth_challenges_expiry ON shorts_auth_challenges(expires_at);
      CREATE INDEX shorts_auth_challenges_address ON shorts_auth_challenges(network,contract,origin,address)`);
    await runner.query(`CREATE TABLE shorts_auth_sessions (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, origin varchar(256) NOT NULL,
      token_hash char(64) NOT NULL, address varchar(100) NOT NULL, expires_at timestamptz NOT NULL,
      PRIMARY KEY(network,contract,origin,token_hash),
      FOREIGN KEY(network,contract,origin) REFERENCES shorts_auth_scopes(network,contract,origin)
    )`);
    await runner.query(`CREATE INDEX shorts_auth_sessions_expiry ON shorts_auth_sessions(expires_at);
      CREATE INDEX shorts_auth_sessions_address ON shorts_auth_sessions(network,contract,origin,address)`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE shorts_auth_sessions');
    await runner.query('DROP TABLE shorts_auth_challenges');
    await runner.query('DROP TABLE shorts_auth_scopes');
  }
}
