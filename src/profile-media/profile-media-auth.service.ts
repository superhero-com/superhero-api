import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { verifyAeAddressSignature } from '../profile/services/profile-signature.util';
import { ProfileMediaDatabase } from './profile-media-database.service';
import {
  imageAddress,
  PROFILE_MEDIA_CONFIG,
  ProfileMediaConfig,
} from './profile-media.config';

@Injectable()
export class ProfileMediaAuth {
  constructor(
    private readonly db: ProfileMediaDatabase,
    @Inject(PROFILE_MEDIA_CONFIG) readonly config: ProfileMediaConfig,
  ) {}
  hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
  async rate(key: string, limit: number, seconds: number) {
    const rows = await this.db.query(
      `INSERT INTO profile_media_rates(scope,key,bucket,count,expires_at)
      VALUES($1,$2,floor(extract(epoch FROM now())/$3),1,now()+make_interval(secs=>$3))
      ON CONFLICT(scope,key,bucket) DO UPDATE SET count=profile_media_rates.count+1
      WHERE profile_media_rates.count<$4 RETURNING count`,
      [this.config.scope, this.hash(key), seconds, limit],
    );
    if (!rows.length)
      throw new HttpException(
        {
          message: 'Too many image requests. Try again later.',
          retryAfter: seconds,
        },
        429,
      );
  }
  async challenge(address: string, purpose?: 'post') {
    if (!imageAddress(address))
      throw new BadRequestException('Invalid wallet address');
    await this.rate(`challenge:${address}`, 10, 300);
    const id = randomBytes(24).toString('hex');
    const expiresAt = Date.now() + 300000;
    const title =
      purpose === 'post' ? 'Superhero post images' : 'Superhero profile images';
    const action =
      purpose === 'post'
        ? 'Publishing a post requires a separate signature.'
        : 'Changing your avatar or cover requires a separate signature.';
    const message = `${title}\nOrigin: ${this.config.origin}\nNetwork: ${this.config.network}\nContract: ${this.config.contract}\nAddress: ${address}\nNonce: ${id}\nExpires: ${new Date(expiresAt).toISOString()}\nAllow image uploads for 30 minutes. ${action} No tokens are transferred.`;
    await this.db.query(
      `INSERT INTO profile_media_auth(scope,id,address,kind,message,expires_at)
      VALUES($1,$2,$3,'challenge',$4,$5)`,
      [this.config.scope, id, address, message, new Date(expiresAt)],
    );
    return { id, message, expiresAt };
  }
  async verify(id: string, signature: string) {
    if (
      typeof id !== 'string' ||
      !/^[a-f0-9]{48}$/.test(id) ||
      typeof signature !== 'string' ||
      signature.length > 256
    )
      throw new UnauthorizedException('Invalid or expired wallet signature');
    const rows = await this.db.query(
      `DELETE FROM profile_media_auth WHERE scope=$1 AND id=$2
      AND kind='challenge' RETURNING *`,
      [this.config.scope, id],
    );
    const row = rows[0]?.[0] ?? rows[0];
    if (
      !row ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      !verifyAeAddressSignature(row.address, row.message, signature)
    )
      throw new UnauthorizedException('Invalid or expired wallet signature');
    const token = randomBytes(32).toString('hex'),
      expiresAt = Date.now() + 1800000;
    await this.db.query(
      `INSERT INTO profile_media_auth(scope,id,address,kind,expires_at)
      VALUES($1,$2,$3,'session',$4)`,
      [this.config.scope, this.hash(token), row.address, new Date(expiresAt)],
    );
    return {
      token,
      address: row.address,
      expiresAt,
    };
  }
  async authenticate(header?: string): Promise<string> {
    if (typeof header !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(header))
      throw new UnauthorizedException('Sign in with your wallet');
    const rows = await this.db.query(
      `SELECT address FROM profile_media_auth WHERE scope=$1 AND id=$2
      AND kind='session' AND expires_at>now()`,
      [this.config.scope, this.hash(header.slice(7))],
    );
    if (!rows.length)
      throw new UnauthorizedException('Sign in with your wallet');
    return rows[0].address;
  }
  async logout(header: string) {
    if (/^Bearer [a-f0-9]{64}$/.test(header || ''))
      await this.db.query(
        `DELETE FROM profile_media_auth WHERE scope=$1 AND id=$2 AND kind='session'`,
        [this.config.scope, this.hash(header.slice(7))],
      );
  }
  async acquireUpload(): Promise<string> {
    const lease = randomUUID();
    for (const slot of [0, 1]) {
      const rows = await this.db.query(
        `INSERT INTO profile_media_slots(scope,slot,lease,expires_at)
        VALUES($1,$2,$3,now()+interval '240 seconds') ON CONFLICT(scope,slot)
        DO UPDATE SET lease=$3,expires_at=excluded.expires_at WHERE profile_media_slots.expires_at<now() RETURNING lease`,
        [this.config.scope, slot, lease],
      );
      if (rows.length) return lease;
    }
    throw new HttpException(
      {
        message: 'Image processing is busy. Try again shortly.',
        retryAfter: 5,
      },
      429,
    );
  }
  async releaseUpload(lease: string) {
    await this.db.query(
      'DELETE FROM profile_media_slots WHERE scope=$1 AND lease=$2',
      [this.config.scope, lease],
    );
  }
}
