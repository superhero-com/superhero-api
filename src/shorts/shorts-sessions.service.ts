import { ShortsDatabaseService } from './shorts-database.service';
import {
  Inject,
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import type { ShortsScope } from './shorts-metadata.service';

export interface ShortsAuthScope extends ShortsScope {
  origin: string;
}

/** Hosted wallet sessions. Tokens are stored only as hashes; no signing keys. */
@Injectable()
export class ShortsSessionsService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}

  private scope(scope: ShortsAuthScope) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract) ||
      typeof scope.origin !== 'string' ||
      scope.origin.length > 256 ||
      new URL(scope.origin).origin !== scope.origin
    )
      throw new BadRequestException('Invalid Shorts authentication scope');
    return [scope.network, scope.contract, scope.origin];
  }
  private async lock(manager: EntityManager, params: string[]) {
    await manager.query(
      `INSERT INTO shorts_auth_scopes VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      params,
    );
    await manager.query(
      `SELECT network FROM shorts_auth_scopes WHERE network=$1 AND contract=$2 AND origin=$3 FOR UPDATE`,
      params,
    );
  }
  private async cleanup(manager: EntityManager, params: string[]) {
    for (const table of ['shorts_auth_challenges', 'shorts_auth_sessions'])
      await manager.query(
        `DELETE FROM ${table} WHERE network=$1 AND contract=$2 AND origin=$3 AND expires_at<=clock_timestamp()`,
        params,
      );
  }
  async challenge(
    scope: ShortsAuthScope,
    address: string,
    message: (id: string, expiresAt: number) => string,
  ) {
    const params = this.scope(scope);
    if (!/^ak_[a-zA-Z0-9]{1,97}$/.test(address))
      throw new BadRequestException('Invalid wallet address');
    return this.db.transaction(async (manager) => {
      await this.lock(manager, params);
      await this.cleanup(manager, params);
      const [count] = await manager.query(
        `SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE address=$4)::integer AS own FROM shorts_auth_challenges
        WHERE network=$1 AND contract=$2 AND origin=$3`,
        [...params, address],
      );
      if (count.total >= 100 || count.own >= 3)
        throw new ForbiddenException(
          'Too many pending sign-in requests; wait for existing challenges to expire',
        );
      const [{ expires }] = await manager.query(
        `SELECT clock_timestamp()+interval '5 minutes' AS expires`,
      );
      const id = randomBytes(24).toString('hex'),
        expiresAt = new Date(expires).getTime();
      const text = message(id, expiresAt);
      if (typeof text !== 'string' || text.length > 2048)
        throw new BadRequestException('Invalid sign-in message');
      await manager.query(
        `INSERT INTO shorts_auth_challenges VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [...params, id, address, text, new Date(expiresAt)],
      );
      return { id, message: text, expiresAt };
    });
  }
  async verify(
    scope: ShortsAuthScope,
    id: string,
    tokenHash: string,
    verify: (address: string, message: string) => boolean,
  ): Promise<{ address: string; expiresAt: number } | 'capacity' | undefined> {
    const params = this.scope(scope);
    if (!/^[a-f0-9]{48}$/.test(id) || !/^[a-f0-9]{64}$/.test(tokenHash))
      return undefined;
    return this.db.transaction(async (manager) => {
      await this.lock(manager, params);
      // Consume even an invalid attempt. Replay and logout-all serialize with issue.
      const [rows] = await manager.query(
        `DELETE FROM shorts_auth_challenges
        WHERE network=$1 AND contract=$2 AND origin=$3 AND id=$4
        RETURNING address,message,expires_at>clock_timestamp() AS active`,
        [...params, id],
      );
      const row = rows[0];
      if (!row || !row.active || !verify(row.address, row.message))
        return undefined;
      await this.cleanup(manager, params);
      const [count] = await manager.query(
        `SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE address=$4)::integer AS own FROM shorts_auth_sessions
        WHERE network=$1 AND contract=$2 AND origin=$3`,
        [...params, row.address],
      );
      if (count.total >= 3000 || count.own >= 30) return 'capacity';
      const [session] = await manager.query(
        `INSERT INTO shorts_auth_sessions
        VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '30 minutes') RETURNING address,expires_at`,
        [...params, tokenHash, row.address],
      );
      return {
        address: session.address,
        expiresAt: new Date(session.expires_at).getTime(),
      };
    });
  }
  async authenticate(scope: ShortsAuthScope, tokenHash: string) {
    const [row] = await this.db.query(
      `SELECT address FROM shorts_auth_sessions
      WHERE network=$1 AND contract=$2 AND origin=$3 AND token_hash=$4 AND expires_at>clock_timestamp()`,
      [...this.scope(scope), tokenHash],
    );
    return row?.address as string | undefined;
  }
  async revoke(scope: ShortsAuthScope, tokenHash: string) {
    await this.db.query(
      `DELETE FROM shorts_auth_sessions
      WHERE network=$1 AND contract=$2 AND origin=$3 AND token_hash=$4`,
      [...this.scope(scope), tokenHash],
    );
  }
  async revokeAll(scope: ShortsAuthScope, tokenHash: string) {
    const params = this.scope(scope);
    return this.db.transaction(async (manager) => {
      await this.lock(manager, params);
      const [session] = await manager.query(
        `SELECT address FROM shorts_auth_sessions
        WHERE network=$1 AND contract=$2 AND origin=$3 AND token_hash=$4 AND expires_at>clock_timestamp()`,
        [...params, tokenHash],
      );
      if (!session) return false;
      for (const table of ['shorts_auth_challenges', 'shorts_auth_sessions'])
        await manager.query(
          `DELETE FROM ${table} WHERE network=$1 AND contract=$2 AND origin=$3 AND address=$4`,
          [...params, session.address],
        );
      return true;
    });
  }
}
