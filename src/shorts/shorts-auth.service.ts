import { shortsRuntimeScope } from './shorts-runtime-scope';
import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { ShortsStoreService } from './shorts-store.service';
import { ShortsChainService } from './shorts-chain.service';
import { verifyAeAddressSignature } from '../profile/services/profile-signature.util';
import {
  ShortsAuthScope,
  ShortsSessionsService,
} from './shorts-sessions.service';

@Injectable()
export class ShortsAuthService {
  readonly connectedWalletAccess: boolean;
  constructor(
    private readonly store: ShortsStoreService,
    private readonly chain: ShortsChainService,
    @Optional() private readonly sessions?: ShortsSessionsService,
  ) {
    this.connectedWalletAccess =
      !sessions &&
      process.env.SHORTS_DEMO_CONNECTED_WALLET === '1' &&
      process.env.SHORTS_TESTNET_MVP === '1' &&
      process.env.NODE_ENV !== 'production';
  }
  get shared() {
    return !!this.sessions;
  }
  private scope(): ShortsAuthScope {
    const origin = new URL(
      process.env.SHORTS_WEB_ORIGIN || 'http://127.0.0.1:5180',
    );
    if (
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== '/' ||
      !(
        origin.protocol === 'https:' ||
        (origin.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
      )
    )
      throw new Error(
        'SHORTS_WEB_ORIGIN must be an HTTPS origin or a local development origin',
      );
    return {
      ...shortsRuntimeScope(this.chain),
      origin: origin.origin,
    };
  }
  private message(
    address: string,
    id: string,
    expires: number,
    scope: ShortsAuthScope,
  ) {
    return `Superhero Shorts sign-in\nOrigin: ${scope.origin}\nNetwork: ${scope.network}\nContract: ${scope.contract}\nAddress: ${address}\nNonce: ${id}\nExpires: ${new Date(expires).toISOString()}\nThis authenticates uploads and creator actions. It does not transfer tokens.`;
  }
  async connect(address: string) {
    if (!this.connectedWalletAccess)
      throw new ForbiddenException('Connection-only Studio access is disabled');
    this.validateAddress(address);
    return this.issue(address, true);
  }
  async challenge(address: string) {
    this.validateAddress(address);
    const scope = this.scope();
    if (this.sessions)
      return this.sessions.challenge(scope, address, (id, expires) =>
        this.message(address, id, expires, scope),
      );
    this.store.db
      .prepare('DELETE FROM challenges WHERE expires<?')
      .run(Date.now());
    const count = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM challenges')
      .get();
    if (Number(count.n) >= 100)
      throw new ForbiddenException('Too many pending sign-in requests');
    const recent = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM challenges WHERE address=?')
      .get(address);
    if (Number(recent.n) >= 3)
      throw new ForbiddenException(
        'Complete or wait for existing sign-in challenges',
      );
    const id = randomBytes(24).toString('hex');
    const expires = Date.now() + 300000;
    const message = this.message(address, id, expires, scope);
    this.store.db
      .prepare('INSERT INTO challenges VALUES(?,?,?,?)')
      .run(id, address, message, expires);
    return { id, message, expiresAt: expires };
  }
  async verify(id: string, signature: string) {
    const check = (address: string, message: string) =>
      typeof signature === 'string' &&
      signature.length <= 256 &&
      verifyAeAddressSignature(address, message, signature);
    if (this.sessions) {
      const token = randomBytes(32).toString('hex');
      const session = await this.sessions.verify(
        this.scope(),
        id,
        this.hash(token),
        check,
      );
      if (session === 'capacity')
        throw new ForbiddenException('Too many active Studio sessions');
      if (!session)
        throw new UnauthorizedException('Invalid or expired signature');
      return { ...session, token, kind: 'wallet-signature' };
    }
    if (typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id))
      throw new UnauthorizedException('Invalid or expired signature');
    const scope = this.scope();
    const candidate = this.store.db
      .prepare('SELECT * FROM challenges WHERE id=?')
      .get(id);
    // Another origin/deployment must not consume this deployment's nonce.
    if (
      !candidate ||
      candidate.message !==
        this.message(
          String(candidate.address),
          id,
          Number(candidate.expires),
          scope,
        )
    )
      throw new UnauthorizedException('Invalid or expired signature');
    const row = this.store.db
      .prepare('DELETE FROM challenges WHERE id=? AND message=? RETURNING *')
      .get(id, candidate.message);
    if (
      !row ||
      Number(row.expires) <= Date.now() ||
      !check(String(row.address), String(row.message))
    )
      throw new UnauthorizedException('Invalid or expired signature');
    return this.issue(String(row.address));
  }
  private issue(address: string, connectedWallet = false) {
    // Demo sessions are kept separate: they never grant operator authority and
    // cannot become verified sessions when the local shortcut is switched off.
    const table = connectedWallet ? 'connected_wallet_sessions' : 'sessions';
    const token = randomBytes(32).toString('hex');
    const expires = Date.now() + 1800000;
    this.store.db
      .prepare(`DELETE FROM ${table} WHERE expires<?`)
      .run(Date.now());
    const count = this.store.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE address=?`)
      .get(address);
    if (Number(count.n) >= 30)
      throw new ForbiddenException('Too many active Studio sessions');
    this.store.db
      .prepare(`INSERT INTO ${table} VALUES(?,?,?)`)
      .run(this.hash(token), address, expires);
    return {
      token,
      address,
      expiresAt: expires,
      kind: connectedWallet ? 'connected-wallet' : 'wallet-signature',
    };
  }
  async authenticate(authorization?: string, verifiedOnly = false) {
    const token = this.token(authorization);
    if (this.sessions) {
      const address = await this.sessions.authenticate(
        this.scope(),
        this.hash(token),
      );
      if (!address) throw new UnauthorizedException('Sign in with your wallet');
      return address;
    }
    let row =
      token &&
      this.store.db
        .prepare('SELECT * FROM sessions WHERE hash=? AND expires>?')
        .get(this.hash(token), Date.now());
    if (!row && token && this.connectedWalletAccess && !verifiedOnly)
      row = this.store.db
        .prepare(
          'SELECT * FROM connected_wallet_sessions WHERE hash=? AND expires>?',
        )
        .get(this.hash(token), Date.now());
    if (!row) throw new UnauthorizedException('Sign in with your wallet');
    return String(row.address);
  }
  async operator(authorization?: string) {
    const address = await this.authenticate(authorization, true);
    if (address !== this.chain.operator.address)
      throw new ForbiddenException('Operator wallet required');
    return address;
  }
  async logout(authorization?: string) {
    const hash = this.hash(this.token(authorization));
    if (this.sessions) await this.sessions.revoke(this.scope(), hash);
    else
      for (const table of ['sessions', 'connected_wallet_sessions'])
        this.store.db.prepare(`DELETE FROM ${table} WHERE hash=?`).run(hash);
    return { revoked: true };
  }
  async logoutAll(authorization?: string) {
    const hash = this.hash(this.token(authorization));
    if (this.sessions) {
      if (!(await this.sessions.revokeAll(this.scope(), hash)))
        throw new UnauthorizedException('Sign in with your wallet');
    } else {
      // Connection-only demo access never grants authority over signed sessions.
      const address = await this.authenticate(authorization, true);
      for (const table of [
        'sessions',
        'connected_wallet_sessions',
        'challenges',
      ])
        this.store.db
          .prepare(`DELETE FROM ${table} WHERE address=?`)
          .run(address);
    }
    return { revoked: true };
  }
  private token(authorization?: string) {
    const token = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) throw new UnauthorizedException('Sign in with your wallet');
    return token;
  }
  private validateAddress(address: string) {
    if (typeof address !== 'string' || address.length > 100)
      throw new BadRequestException('Invalid AE address');
    try {
      this.chain.address(address);
    } catch {
      throw new BadRequestException('Invalid AE address');
    }
  }
  private hash(value: string) {
    const scope = this.sessions ? undefined : this.scope();
    return createHash('sha256')
      .update(
        scope
          ? `shorts-local-session:v2\n${JSON.stringify([scope.network, scope.contract, scope.origin])}\n${value}`
          : value,
      )
      .digest('hex');
  }
}
