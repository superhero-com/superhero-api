import {
  imageReference,
  profileImageCid,
  profileImageReference,
} from './image-reference';
import { ProfileMediaAuth } from './profile-media-auth.service';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { decode } from '@aeternity/aepp-sdk';
import { verifyAeAddressSignature } from '../profile/services/profile-signature.util';
import { ProfileMediaDatabase } from './profile-media-database.service';
import { ProfileMediaChain } from './profile-media-chain.service';
import {
  ImageRole,
  imageAddress,
  imageCid,
  imageRole,
  PROFILE_MEDIA_CONFIG,
  ProfileMediaConfig,
} from './profile-media.config';

export interface ProfileImages {
  address: string;
  avatarurl: string;
  avatar_thumbnail_url: string;
  coverurl: string;
  cover_thumbnail_url: string;
  avatar_ref: string;
  avatar_preview_ref: string;
  cover_ref: string;
  cover_preview_ref: string;
  avatar_cid: string | null;
  cover_cid: string | null;
}

@Injectable()
export class ProfileMediaService implements OnApplicationBootstrap {
  private readonly linksCache = new Map<
    string,
    { at: number; value: Promise<Record<string, string>> }
  >();
  private reconciling = false;
  constructor(
    private readonly db: ProfileMediaDatabase,
    private readonly auth: ProfileMediaAuth,
    private readonly chain: ProfileMediaChain,
    @Inject(PROFILE_MEDIA_CONFIG) readonly config: ProfileMediaConfig,
  ) {}

  async onApplicationBootstrap() {
    if (this.config.enabled) {
      await this.chain.ensureProviders();
      await this.db.query(
        'SELECT ready,deleted_at FROM profile_media_assets LIMIT 0',
      );
    }
  }

  private async asset(cid: string) {
    if (!imageCid(cid)) throw new NotFoundException('Image not found');
    const rows = await this.db.query(
      'SELECT * FROM profile_media_assets WHERE scope=$1 AND cid=$2',
      [this.config.scope, cid],
    );
    if (!rows.length) throw new NotFoundException('Image not found');
    return rows[0];
  }

  async claim(address: string, role: ImageRole, cid: string | null) {
    if (!imageRole(role) || (cid !== null && !imageCid(cid)))
      throw new BadRequestException('Invalid image change');
    if (!cid && !(await this.chain.links(address))[role])
      throw new BadRequestException('This image is already removed');
    const nonce = await this.chain.nonce(address),
      id = randomUUID();
    const message = this.chain.message(address, role, nonce, cid);
    await this.db.transaction(async (db) => {
      if (cid) {
        const [asset] = await db.query(
          'SELECT * FROM profile_media_assets WHERE scope=$1 AND cid=$2 FOR UPDATE',
          [this.config.scope, cid],
        );
        if (
          !asset ||
          asset.address !== address ||
          asset.role !== role ||
          !asset.ready
        )
          throw new BadRequestException(
            'Choose an available image uploaded by this wallet',
          );
      }
      await db.query(
        `INSERT INTO profile_media_writes(scope,id,address,role,cid,nonce,message,state,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'prepared',now()+interval '5 minutes')`,
        [this.config.scope, id, address, role, cid, nonce, message],
      );
    });
    return {
      id,
      message,
      nonce,
      value: cid ? profileImageReference(cid) : null,
      reference: cid ? imageReference(cid) : null,
      role,
    };
  }

  async submit(address: string, id: string, signature: string) {
    if (typeof signature !== 'string' || signature.length > 256)
      throw new BadRequestException('Invalid signature');
    const db = this.db.createQueryRunner();
    await db.connect();
    let locked = false;
    try {
      const lock = await db.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
        [`profile-media:${this.chain.providerAddress}`],
      );
      locked = lock[0].locked;
      if (!locked)
        throw new ConflictException(
          'Another image change is being submitted. Try again shortly.',
        );
      const rows = await db.query(
        'SELECT * FROM profile_media_writes WHERE scope=$1 AND id=$2 AND address=$3',
        [this.config.scope, id, address],
      );
      const row = rows[0];
      if (!row) throw new NotFoundException('Image change not found');
      if (row.state !== 'prepared') return this.writeStatus(row);
      if (new Date(row.expires_at).getTime() < Date.now())
        throw new ConflictException(
          'The signature request expired. Please sign again.',
        );
      const legacyMessage = row.cid
        ? `link:${address}:${row.role}:${row.cid}:${row.nonce}`
        : undefined;
      if (
        row.message !==
          this.chain.message(address, row.role, Number(row.nonce), row.cid) &&
        row.message !== legacyMessage
      ) {
        await db.query(
          `UPDATE profile_media_writes SET state='failed',error='Please review and sign the image change again',updated_at=now()
          WHERE scope=$1 AND id=$2 AND state='prepared'`,
          [this.config.scope, id],
        );
        throw new ConflictException(
          'The image signature format changed. Please review and sign again.',
        );
      }
      if (!verifyAeAddressSignature(address, row.message, signature))
        throw new BadRequestException('Wallet signature verification failed');
      if (row.cid) {
        const asset = await this.asset(row.cid);
        if (!asset.ready) throw new GoneException('This image is unavailable');
      }
      const pending = await db.query(
        `SELECT id FROM profile_media_writes WHERE scope=$1 AND state IN ('signed','submitted') LIMIT 1`,
        [this.config.scope],
      );
      if (pending.length)
        throw new ConflictException(
          'An image transaction is confirming. Try again shortly.',
        );
      await this.auth.rate('writes:global', 120, 3600);
      const hex = signature.startsWith('sg_')
        ? Buffer.from(decode(signature as any)).toString('hex')
        : signature;
      try {
        await this.chain.submit(
          address,
          row.role,
          Number(row.nonce),
          row.cid
            ? row.message === legacyMessage
              ? row.cid
              : profileImageReference(row.cid)
            : null,
          hex,
          async (tx, hash) => {
            await db.query(
              `UPDATE profile_media_writes SET signed_tx=$3,tx_hash=$4,state='signed',updated_at=now()
            WHERE scope=$1 AND id=$2`,
              [this.config.scope, id, tx, hash],
            );
          },
        );
        await db.query(
          `UPDATE profile_media_writes SET state='submitted',updated_at=now() WHERE scope=$1 AND id=$2`,
          [this.config.scope, id],
        );
      } catch (error) {
        const current = (
          await db.query(
            'SELECT * FROM profile_media_writes WHERE scope=$1 AND id=$2',
            [this.config.scope, id],
          )
        )[0];
        if (current.signed_tx) return this.writeStatus(current);
        await db.query(
          `UPDATE profile_media_writes SET state='failed',error='The change was not submitted',updated_at=now() WHERE scope=$1 AND id=$2`,
          [this.config.scope, id],
        );
        throw error;
      }
      return this.status(address, id);
    } finally {
      if (locked)
        await db
          .query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
            `profile-media:${this.chain.providerAddress}`,
          ])
          .catch(() => {});
      await db.release();
    }
  }

  private writeStatus(row: any) {
    return {
      id: row.id,
      role: row.role,
      cid: row.cid,
      status: row.state,
      txHash: row.tx_hash || null,
      error: row.error || null,
    };
  }
  async recoveryStatus(address: string, id: string) {
    if (!imageAddress(address))
      throw new BadRequestException('Invalid wallet address');
    // A saved random operation ID can check completion after its session expires.
    // Do not expose unpublished assets, signatures, or authentication material.
    // Maintenance reconciles the chain independently; this endpoint only reads.
    const [row] = await this.db.query(
      'SELECT id,role,state FROM profile_media_writes WHERE scope=$1 AND id=$2 AND address=$3',
      [this.config.scope, id, address],
    );
    if (!row) throw new NotFoundException('Image change not found');
    return { id: row.id, role: row.role, status: row.state };
  }
  async status(address: string, id: string) {
    const rows = await this.db.query(
      'SELECT * FROM profile_media_writes WHERE scope=$1 AND id=$2 AND address=$3',
      [this.config.scope, id, address],
    );
    if (!rows.length) throw new NotFoundException('Image change not found');
    await this.reconcile(rows[0]);
    const row = (
      await this.db.query(
        'SELECT * FROM profile_media_writes WHERE scope=$1 AND id=$2',
        [this.config.scope, id],
      )
    )[0];
    return this.writeStatus(row);
  }
  private async reconcile(row: any) {
    if (!['signed', 'submitted'].includes(row.state) || !row.tx_hash) return;
    const state = await this.chain.transaction(row.tx_hash);
    if (state === 'missing') {
      // The same signed transaction is idempotent; never create a replacement here.
      if (!(await this.chain.expired(row.signed_tx)))
        await this.chain.rebroadcast(row.signed_tx).catch(() => {});
      else
        await this.db.query(
          `UPDATE profile_media_writes SET state='failed',error='Transaction expired; please try again',updated_at=now()
        WHERE scope=$1 AND id=$2 AND state IN ('signed','submitted')`,
          [this.config.scope, row.id],
        );
      return;
    }
    if (state === 'pending') return;
    await this.db.transaction(async (db) => {
      await db.query(
        `UPDATE profile_media_writes SET state=$3,error=$4,updated_at=now() WHERE scope=$1 AND id=$2`,
        [
          this.config.scope,
          row.id,
          state,
          state === 'failed' ? 'The identity transaction was rejected' : null,
        ],
      );
      if (state === 'confirmed') {
        await db.query(
          `UPDATE profile_media_assets SET replaced_at=now() WHERE scope=$1 AND address=$2 AND role=$3 AND cid IS DISTINCT FROM $4 AND last_linked_at IS NOT NULL`,
          [this.config.scope, row.address, row.role, row.cid],
        );
        if (row.cid)
          await db.query(
            `UPDATE profile_media_assets SET last_linked_at=now(),replaced_at=NULL WHERE scope=$1 AND cid=$2`,
            [this.config.scope, row.cid],
          );
      }
    });
    this.linksCache.delete(row.address);
  }

  private async links(address: string) {
    const cached = this.linksCache.get(address);
    if (cached && Date.now() - cached.at < 15000) return cached.value;
    if (this.linksCache.size >= 1000)
      this.linksCache.delete(this.linksCache.keys().next().value!);
    const value = this.chain.links(address).catch((error) => {
      this.linksCache.delete(address);
      throw error;
    });
    this.linksCache.set(address, { at: Date.now(), value });
    return value;
  }
  empty(address: string): ProfileImages {
    return {
      address,
      avatarurl: '',
      avatar_thumbnail_url: '',
      coverurl: '',
      cover_thumbnail_url: '',
      avatar_ref: '',
      avatar_preview_ref: '',
      cover_ref: '',
      cover_preview_ref: '',
      avatar_cid: null,
      cover_cid: null,
    };
  }
  async images(address: string): Promise<ProfileImages> {
    const result = this.empty(address);
    if (!this.config.enabled) return result;
    if (!imageAddress(address))
      throw new BadRequestException('Invalid wallet address');
    const rawLinks = await this.links(address);
    const links = {
      avatar: profileImageCid(rawLinks.avatar),
      cover: profileImageCid(rawLinks.cover),
    };
    const cids = [links.avatar, links.cover].filter(imageCid);
    if (!cids.length) return result;
    const assets = await this.db.query(
      `SELECT cid,address,role,ready FROM profile_media_assets WHERE scope=$1 AND cid=ANY($2::text[])`,
      [this.config.scope, cids],
    );
    for (const asset of assets) {
      if (
        !asset.ready ||
        asset.address !== address ||
        links[asset.role] !== asset.cid
      )
        continue;
      // Covers external resubmission and recovery; chain state remains canonical.
      await this.db.query(
        'UPDATE profile_media_assets SET last_linked_at=COALESCE(last_linked_at,now()) WHERE scope=$1 AND cid=$2 AND ready',
        [this.config.scope, asset.cid],
      );
      const url = `${this.config.publicUrl}/images/${asset.cid}`;
      if (asset.role === 'avatar') {
        result.avatarurl = `${url}/image.webp`;
        result.avatar_thumbnail_url = `${url}/thumb.webp`;
        result.avatar_cid = asset.cid;
        result.avatar_ref = imageReference(asset.cid);
        result.avatar_preview_ref = imageReference(asset.cid, true);
      } else {
        result.coverurl = `${url}/image.webp`;
        result.cover_cid = asset.cid;
        result.cover_thumbnail_url = `${url}/thumb.webp`;
        result.cover_ref = imageReference(asset.cid);
        result.cover_preview_ref = imageReference(asset.cid, true);
      }
    }
    return result;
  }
  async batch(addresses: string[]) {
    if (
      !Array.isArray(addresses) ||
      addresses.length > 50 ||
      !addresses.every(imageAddress)
    )
      throw new BadRequestException('Request up to 50 wallet addresses');
    const unique = [...new Set(addresses)],
      results: ProfileImages[] = [];
    for (let i = 0; i < unique.length; i += 4)
      results.push(
        ...(await Promise.all(
          unique.slice(i, i + 4).map((address) => this.images(address)),
        )),
      );
    return results;
  }
  @Cron('*/5 * * * * *')
  async maintenance() {
    if (!this.config.enabled || this.reconciling) return;
    this.reconciling = true;
    try {
      const rows = await this.db.query(
        `SELECT * FROM profile_media_writes WHERE scope=$1 AND state IN ('signed','submitted') ORDER BY created_at LIMIT 10`,
        [this.config.scope],
      );
      for (const row of rows) await this.reconcile(row).catch(() => {});
      await this.db.query(
        'DELETE FROM profile_media_auth WHERE scope=$1 AND expires_at<now()',
        [this.config.scope],
      );
      await this.db.query(
        'DELETE FROM profile_media_rates WHERE scope=$1 AND expires_at<now()',
        [this.config.scope],
      );
      await this.db.query(
        `UPDATE profile_media_writes SET state='failed',error='Signature request expired' WHERE scope=$1 AND state='prepared' AND expires_at<now()`,
        [this.config.scope],
      );
      // ProfileMediaRetention authorizes old-image cleanup independently of
      // transaction confirmation; the byte worker owns the deletion journal.
    } finally {
      this.reconciling = false;
    }
  }
}
