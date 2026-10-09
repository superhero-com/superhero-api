import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { ShortsStoreService } from './shorts-store.service';
import { ShortsChainService } from './shorts-chain.service';
import { verifyAeAddressSignature } from '../profile/services/profile-signature.util';

@Injectable()
export class ShortsAuthService {
  readonly connectedWalletAccess =
    process.env.SHORTS_DEMO_CONNECTED_WALLET === '1' &&
    process.env.SHORTS_TESTNET_MVP === '1' &&
    process.env.NODE_ENV !== 'production';
  constructor(
    private readonly store: ShortsStoreService,
    private readonly chain: ShortsChainService,
  ) {}
  connect(address: string) {
    if (!this.connectedWalletAccess)
      throw new ForbiddenException('Connection-only Studio access is disabled');
    this.chain.address(address);
    return this.issue(address, true);
  }
  challenge(address: string) {
    this.chain.address(address);
    this.store.db
      .prepare('DELETE FROM challenges WHERE expires<?')
      .run(Date.now());
    const count = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM challenges')
      .get();
    if (Number(count.n) > 100)
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
    const message = `Superhero Shorts sign-in\nOrigin: ${process.env.SHORTS_WEB_ORIGIN || 'http://127.0.0.1:5180'}\nNetwork: ae_uat\nContract: ${this.chain.state.contract}\nAddress: ${address}\nNonce: ${id}\nExpires: ${new Date(expires).toISOString()}\nThis authenticates uploads and creator actions. It does not transfer tokens.`;
    this.store.db
      .prepare('INSERT INTO challenges VALUES(?,?,?,?)')
      .run(id, address, message, expires);
    return { id, message, expiresAt: expires };
  }
  verify(id: string, signature: string) {
    const row = this.store.db
      .prepare('DELETE FROM challenges WHERE id=? RETURNING *')
      .get(id);
    if (
      !row ||
      Number(row.expires) < Date.now() ||
      !verifyAeAddressSignature(
        String(row.address),
        String(row.message),
        signature,
      )
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
  authenticate(authorization?: string, verifiedOnly = false) {
    const token = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
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
  operator(authorization?: string) {
    const address = this.authenticate(authorization, true);
    if (address !== this.chain.operator.address)
      throw new ForbiddenException('Operator wallet required');
    return address;
  }
  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
