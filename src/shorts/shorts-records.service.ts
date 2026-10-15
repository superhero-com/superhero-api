import { shortsRuntimeScope } from './shorts-runtime-scope';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ShortsChainService } from './shorts-chain.service';
import {
  ShortsMetadataService,
  ShortsScope,
  StoredShort,
} from './shorts-metadata.service';
import { ShortRecord } from './shorts.types';
import { CatalogPosition, CATALOG_PAGE_SIZE } from './shorts-catalog';

/** Content access for hosted PostgreSQL and the deliberately single-process local demo. */
@Injectable()
export class ShortsRecordsService implements OnModuleInit {
  constructor(
    readonly chain: ShortsChainService,
    @Optional() private readonly metadata?: ShortsMetadataService,
  ) {}
  get shared() {
    return !!this.metadata;
  }
  private scope(): ShortsScope {
    if (!this.chain.state.contract)
      throw new ServiceUnavailableException(
        'Shorts deployment is not initialized',
      );
    return shortsRuntimeScope(this.chain);
  }
  private fingerprint(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  async onModuleInit() {
    if (!this.metadata) return;
    if (this.chain.state.shorts.length)
      throw new ConflictException(
        'Move the local snapshot through the offline legacy migration',
      );
    await this.metadata.initialize(this.scope(), this.chain.state.sourceHash);
    await this.metadata.verifyHostedStorage(this.scope());
  }
  async read(id: string): Promise<StoredShort> {
    if (this.metadata) return this.metadata.get(this.scope(), id);
    const record = this.chain.state.shorts.find((short) => short.id === id);
    if (!record) throw new NotFoundException('Short not found');
    return {
      record: structuredClone(record),
      revision: this.fingerprint(record),
    };
  }
  async find(id: string): Promise<ShortRecord | undefined> {
    try {
      return (await this.read(id)).record;
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
  }
  async get(id: string) {
    return (await this.read(id)).record;
  }
  async page(
    creator?: string,
    after?: CatalogPosition,
  ): Promise<{ items: ShortRecord[]; next?: CatalogPosition }> {
    if (creator !== undefined && !/^ak_[a-zA-Z0-9]{1,97}$/.test(creator))
      throw new BadRequestException('Invalid creator');
    return this.readPage(after, creator, !creator);
  }
  /** Internal operator read; the HTTP caller must authorize operator access. */
  async reviewPage(after?: CatalogPosition) {
    return this.readPage(after, undefined, false);
  }
  private async readPage(
    after: CatalogPosition | undefined,
    creator: string | undefined,
    publishedOnly: boolean,
  ): Promise<{ items: ShortRecord[]; next?: CatalogPosition }> {
    if (this.metadata) {
      const page = await this.metadata.page(this.scope(), {
        creator,
        after,
        limit: CATALOG_PAGE_SIZE,
        publishedOnly,
      });
      return { items: page.items.map((item) => item.record), next: page.next };
    }
    // The local adapter deliberately retains its existing 50-video admission cap.
    const ordered = this.chain.state.shorts
      .filter(
        (short) =>
          (!creator || short.creator === creator) &&
          (!publishedOnly ||
            (short.publication === 'published' &&
              short.moderation !== 'rejected')) &&
          (!after ||
            short.createdAt < after.at ||
            (short.createdAt === after.at && short.id < after.id)),
      )
      .sort(
        (a, b) =>
          b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
    const items = structuredClone(ordered.slice(0, CATALOG_PAGE_SIZE));
    const last = items.at(-1);
    return {
      items,
      next:
        last && ordered.length > items.length
          ? { at: last.createdAt, id: last.id }
          : undefined,
    };
  }
  async all(creator?: string): Promise<ShortRecord[]> {
    if (!this.metadata)
      return structuredClone(
        this.chain.state.shorts.filter(
          (short) => !creator || short.creator === creator,
        ),
      );
    // Hosted callers must choose a bounded page or a dedicated SQL aggregate.
    throw new ServiceUnavailableException(
      'Whole-library reads are disabled in the hosted API',
    );
  }
  async register(record: ShortRecord) {
    if (this.metadata)
      return (await this.metadata.insertDraft(this.scope(), record)).record;
    return this.chain.registerPrepared(record);
  }
  async change(
    id: string,
    update: (record: ShortRecord) => void,
  ): Promise<ShortRecord> {
    if (this.metadata)
      return (await this.metadata.change(this.scope(), id, update)).record;
    const { record, revision } = await this.read(id);
    const result: unknown = update(record);
    if (result && typeof (result as any).then === 'function')
      throw new Error('Metadata changes must be synchronous');
    return this.replace(record, revision);
  }
  async replace(record: ShortRecord, revision: string): Promise<ShortRecord> {
    if (this.metadata)
      return (await this.metadata.replace(this.scope(), record, revision))
        .record;
    const current = this.chain.state.shorts.find(
      (short) => short.id === record.id,
    );
    if (!current || this.fingerprint(current) !== revision)
      throw new ConflictException(
        'Short changed; read it again before updating',
      );
    const previous = structuredClone(current);
    // Keep object identity for local helpers, but remove fields explicitly cleared.
    for (const key of Object.keys(current)) delete current[key];
    Object.assign(current, record);
    try {
      await this.chain.save();
    } catch (error) {
      for (const key of Object.keys(current)) delete current[key];
      Object.assign(current, previous);
      throw error;
    }
    return structuredClone(current);
  }
}
