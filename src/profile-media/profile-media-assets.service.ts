import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ProfileMediaDatabase } from './profile-media-database.service';
import {
  ProfileMediaStorage,
  profileImageHash,
} from './profile-media-storage.service';
import { ProfileMediaEncoder } from './profile-media-encoder.service';
import {
  MediaRole,
  mediaRole,
  imageCid,
  PROFILE_MEDIA_CONFIG,
  ProfileMediaConfig,
} from './profile-media.config';

/** Byte processing and public delivery: instantiated only in the separate image worker. */
@Injectable()
export class ProfileMediaAssets {
  constructor(
    private readonly db: ProfileMediaDatabase,
    private readonly storage: ProfileMediaStorage,
    private readonly encoder: ProfileMediaEncoder,
    @Inject(PROFILE_MEDIA_CONFIG) readonly config: ProfileMediaConfig,
  ) {}
  async prepare(address: string, role: MediaRole, input: Buffer) {
    if (!mediaRole(role))
      throw new BadRequestException('Choose avatar, cover or post');
    const encoded = await this.encoder.encode(input, role);
    const manifest = Buffer.from(
      JSON.stringify({
        version: 1,
        network: this.config.network,
        contract: this.config.contract,
        owner: address,
        role,
        width: encoded.width,
        height: encoded.height,
        image: profileImageHash(encoded.image),
        thumb: profileImageHash(encoded.thumb),
      }),
    );
    const packageFiles = [
      { name: 'image.webp', data: encoded.image },
      { name: 'thumb.webp', data: encoded.thumb },
      { name: 'manifest.json', data: manifest },
    ];
    const prepared = await this.storage.prepare(packageFiles);
    const bytes = prepared.files.reduce((sum, file) => sum + file.bytes, 0);
    await this.db.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `profile-media-storage:${this.config.scope}`,
      ]);
      const existing = await db.query(
        'SELECT cid,cleanup_requested_at,deleted_at FROM profile_media_assets WHERE scope=$1 AND cid=$2 FOR UPDATE',
        [this.config.scope, prepared.cid],
      );
      if (existing[0]?.cleanup_requested_at && !existing[0].deleted_at)
        throw new ServiceUnavailableException(
          'This image is being cleaned up. Try again shortly.',
        );
      if (existing.length && !existing[0].deleted_at) return;
      const used = await db.query(
        'SELECT coalesce(sum(bytes),0)::text AS bytes FROM profile_media_assets WHERE scope=$1 AND deleted_at IS NULL',
        [this.config.scope],
      );
      if (Number(used[0].bytes) + bytes > this.config.maxStoredBytes)
        throw new ServiceUnavailableException(
          'Profile image storage is full. Please try again later.',
        );
      await db.query(
        `INSERT INTO profile_media_assets(scope,cid,address,role,files,bytes) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(scope,cid) DO UPDATE SET files=EXCLUDED.files,bytes=EXCLUDED.bytes,ready=false,
        created_at=now(),last_linked_at=NULL,replaced_at=NULL,cleanup_requested_at=NULL,
        cleanup_blocks=NULL,cleanup_retry_at=NULL,deleted_at=NULL`,
        [
          this.config.scope,
          prepared.cid,
          address,
          role,
          JSON.stringify(prepared.files),
          bytes,
        ],
      );
    });
    const asset = await this.asset(prepared.cid);
    if (!asset.ready) {
      const pinned = await this.storage.pin(packageFiles);
      if (pinned.cid !== prepared.cid)
        throw new ServiceUnavailableException('Image commitment mismatch');
      // Verify exactly the stored normalized bytes before offering a link challenge.
      await this.storage.read(pinned.cid, pinned.files[0]);
      await this.db.query(
        'UPDATE profile_media_assets SET ready=true WHERE scope=$1 AND cid=$2',
        [this.config.scope, prepared.cid],
      );
    }
    return {
      cid: prepared.cid,
      role,
      width: encoded.width,
      height: encoded.height,
      bytes,
    };
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

  async image(cid: string, name: string) {
    const asset = await this.asset(cid);
    if (!asset.ready || !['image.webp', 'thumb.webp'].includes(name))
      throw new NotFoundException('Image not found');
    if (asset.role !== 'post' && !asset.last_linked_at)
      throw new NotFoundException('Image not found');
    const file = asset.files.find((entry: any) => entry.name === name);
    if (!file) throw new NotFoundException('Image not found');
    return { data: await this.storage.read(cid, file), etag: file.sha256 };
  }
}
