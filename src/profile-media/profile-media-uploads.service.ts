import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  ShortsPrivateObjectsService,
  PrivateObjectRef,
} from '../shorts/shorts-private-objects.service';
import { ProfileMediaDatabase } from './profile-media-database.service';
import {
  PROFILE_MEDIA_CONFIG,
  ProfileMediaConfig,
  MediaRole,
  mediaRole,
  IMAGE_MAX_BYTES,
} from './profile-media.config';

export const PROFILE_MEDIA_OBJECTS = Symbol('PROFILE_MEDIA_OBJECTS');
export const IMAGE_PART_BYTES = 1024 * 1024;
interface Part {
  object: PrivateObjectRef;
  iv: string;
  checksum?: string;
  complete?: boolean;
}

/** Metadata only. Raw upload bytes go directly from the client to object storage. */
@Injectable()
export class ProfileMediaUploads {
  constructor(
    private readonly db: ProfileMediaDatabase,
    @Inject(PROFILE_MEDIA_OBJECTS)
    readonly objects: ShortsPrivateObjectsService,
    @Inject(PROFILE_MEDIA_CONFIG) readonly config: ProfileMediaConfig,
  ) {}
  scope() {
    return {
      network: this.config.network,
      contract: this.config.storageContract || this.config.contract,
    };
  }
  private async own(db: any, address: string, id: string, lock = false) {
    const [row] = await db.query(
      `SELECT * FROM profile_media_uploads WHERE scope=$1 AND id=$2 AND address=$3 ${lock ? 'FOR UPDATE' : ''}`,
      [this.config.scope, id, address],
    );
    if (!row) throw new NotFoundException('Image upload not found');
    return row;
  }
  private uploading(row: any) {
    if (row.state !== 'uploading')
      throw new ConflictException('This upload is already being processed');
    if (new Date(row.expires_at).getTime() <= Date.now())
      throw new GoneException('Image upload expired. Choose the image again.');
  }
  private view(row: any) {
    return {
      id: row.id,
      role: row.role,
      status: row.state,
      cid: row.cid || null,
      bytes: row.bytes,
      partSize: IMAGE_PART_BYTES,
      transport: 'direct-s3-v1',
      parts: Object.entries(row.parts as Record<string, Part>)
        .filter(([, part]) => part.complete)
        .map(([index]) => Number(index)),
      expiresAt: new Date(row.expires_at).getTime(),
      error: row.error || null,
    };
  }
  async create(
    address: string,
    role: MediaRole,
    bytes: number,
    sha256: string,
  ) {
    if (
      !mediaRole(role) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > IMAGE_MAX_BYTES ||
      !/^[a-f0-9]{64}$/.test(sha256)
    )
      throw new BadRequestException('Invalid image upload');
    this.objects.assertDirectUploadsConfigured();
    const id = randomUUID();
    await this.db.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `profile-media-uploads:${this.config.scope}`,
      ]);
      const [used] = await db.query(
        'SELECT coalesce(sum(bytes + ceil(bytes / 1048576.0) * 36),0)::text AS bytes FROM profile_media_uploads WHERE scope=$1 AND source_deleted_at IS NULL',
        [this.config.scope],
      );
      if (
        Number(used.bytes) + bytes + Math.ceil(bytes / IMAGE_PART_BYTES) * 36 >
        this.config.maxStoredBytes / 2
      )
        throw new ServiceUnavailableException(
          'Image upload storage is full. Please try again later.',
        );
      const active = await db.query(
        `SELECT id FROM profile_media_uploads WHERE scope=$1 AND address=$2 AND (state IN ('queued','processing') OR (state='uploading' AND expires_at>now())) LIMIT 2`,
        [this.config.scope, address],
      );
      if (active.length >= 2)
        throw new ConflictException('Finish the current image uploads first');
      await db.query(
        `INSERT INTO profile_media_uploads(scope,id,address,role,bytes,sha256,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,'uploading',now()+interval '30 minutes')`,
        [this.config.scope, id, address, role, bytes, sha256],
      );
    });
    return this.status(address, id);
  }
  async status(address: string, id: string) {
    return this.view(await this.own(this.db, address, id));
  }
  async prepare(address: string, id: string, index: number, sha256: string) {
    if (!Number.isInteger(index) || index < 0 || !/^[a-f0-9]{64}$/.test(sha256))
      throw new BadRequestException('Invalid image part');
    return this.db.transaction(async (db) => {
      const row = await this.own(db, address, id, true);
      this.uploading(row);
      if (index >= Math.ceil(row.bytes / IMAGE_PART_BYTES))
        throw new BadRequestException('Invalid image part');
      let part: Part = row.parts[index];
      if (part && part.object.sha256 !== sha256)
        throw new ConflictException(
          'The selected image changed. Start a new upload.',
        );
      if (!part) {
        part = {
          object: this.objects.directReference(
            this.scope(),
            `profile-${id}`,
            index,
            Math.min(IMAGE_PART_BYTES, row.bytes - index * IMAGE_PART_BYTES),
            sha256,
          ),
          iv: randomBytes(12).toString('hex'),
        };
        row.parts[index] = part;
        await db.query(
          'UPDATE profile_media_uploads SET parts=$3 WHERE scope=$1 AND id=$2',
          [this.config.scope, id, JSON.stringify(row.parts)],
        );
      }
      return this.objects.directEncryption(this.scope(), part.object, part.iv);
    });
  }
  async authorize(
    address: string,
    id: string,
    index: number,
    checksum: string,
  ) {
    if (!/^[a-f0-9]{64}$/.test(checksum))
      throw new BadRequestException('Invalid image checksum');
    const { part, expiresAt } = await this.db.transaction(async (db) => {
      const row = await this.own(db, address, id, true);
      this.uploading(row);
      const part: Part = row.parts[index];
      if (!part) throw new BadRequestException('Prepare the image part first');
      if (part.checksum && part.checksum !== checksum)
        throw new ConflictException('The encrypted image part changed');
      part.checksum = checksum;
      await db.query(
        'UPDATE profile_media_uploads SET parts=$3 WHERE scope=$1 AND id=$2',
        [this.config.scope, id, JSON.stringify(row.parts)],
      );
      return { part, expiresAt: new Date(row.expires_at).getTime() };
    });
    return this.objects.directUrl(
      this.scope(),
      part.object,
      checksum,
      expiresAt,
    );
  }
  async complete(address: string, id: string, index: number) {
    const row = await this.own(this.db, address, id);
    this.uploading(row);
    const part: Part = row.parts[index];
    if (!part?.checksum)
      throw new BadRequestException('Authorize the image part first');
    await this.objects.verifyDirect(this.scope(), part.object, part.checksum);
    await this.db.transaction(async (db) => {
      const current = await this.own(db, address, id, true);
      this.uploading(current);
      if (current.parts[index]?.checksum !== part.checksum)
        throw new ConflictException('Image part changed');
      current.parts[index].complete = true;
      await db.query(
        'UPDATE profile_media_uploads SET parts=$3 WHERE scope=$1 AND id=$2',
        [this.config.scope, id, JSON.stringify(current.parts)],
      );
    });
    return this.status(address, id);
  }
  async cancel(address: string, id: string) {
    await this.db.query(
      `UPDATE profile_media_uploads SET state='failed',error='Upload cancelled',updated_at=now()
      WHERE scope=$1 AND id=$2 AND address=$3 AND state IN ('uploading','queued')`,
      [this.config.scope, id, address],
    );
    return this.status(address, id);
  }
  async finish(address: string, id: string) {
    await this.db.transaction(async (db) => {
      const row = await this.own(db, address, id, true);
      if (row.state !== 'uploading') return;
      this.uploading(row);
      for (
        let index = 0;
        index < Math.ceil(row.bytes / IMAGE_PART_BYTES);
        index++
      )
        if (!row.parts[index]?.complete)
          throw new BadRequestException(
            'Finish uploading every image part first',
          );
      await db.query(
        `UPDATE profile_media_uploads SET state='queued',updated_at=now() WHERE scope=$1 AND id=$2`,
        [this.config.scope, id],
      );
    });
    return this.status(address, id);
  }
}
