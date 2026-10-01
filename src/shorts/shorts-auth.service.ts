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
  constructor(
    private readonly store: ShortsStoreService,
    private readonly chain: ShortsChainService,
  ) {}
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
    const message = `Superhero Shorts sign-in\nOrigin: http://127.0.0.1:5180\nNetwork: ae_uat\nContract: ${this.chain.state.contract}\nAddress: ${address}\nNonce: ${id}\nExpires: ${new Date(expires).toISOString()}\nThis authenticates uploads and creator actions. It does not transfer tokens.`;
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
    const token = randomBytes(32).toString('hex');
    const expires = Date.now() + 1800000;
    this.store.db
      .prepare('DELETE FROM sessions WHERE expires<?')
      .run(Date.now());
    this.store.db
      .prepare('INSERT INTO sessions VALUES(?,?,?)')
      .run(this.hash(token), row.address, expires);
    return { token, address: row.address, expiresAt: expires };
  }
  authenticate(authorization?: string) {
    const token = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const row =
      token &&
      this.store.db
        .prepare('SELECT * FROM sessions WHERE hash=? AND expires>?')
        .get(this.hash(token), Date.now());
    if (!row) throw new UnauthorizedException('Sign in with your wallet');
    return String(row.address);
  }
  operator(authorization?: string) {
    const address = this.authenticate(authorization);
    if (address !== this.chain.operator.address)
      throw new ForbiddenException('Operator wallet required');
    return address;
  }
  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
