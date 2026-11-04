import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import {
  IngestionInput,
  ShortsMetadataService,
  ShortsScope,
} from './shorts-metadata.service';
import { validateOriginalContent } from './shorts-original-content';
import { officialContentPolicy } from './shorts-eligibility';
import { shortsPlaybackDescriptor } from './shorts-playback-descriptor';
import { sourceKey } from './hls-protocol/hls-package';
import type { ShortRecord } from './shorts.types';
import {
  shortsDeliverySource,
  assertDeliverySourcePreparation,
} from './shorts-delivery-source';

/** Internal operations only. Preparing media never selects or publishes it. */
@Injectable()
export class ShortsDeliveryGenerationsService {
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    private readonly metadata: ShortsMetadataService,
  ) {}

  private args(scope: ShortsScope, id: string) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(id)
    )
      throw new Error('Invalid delivery identity');
    return [scope.network, scope.contract, id];
  }
  async enqueue(
    scope: ShortsScope,
    jobId: string,
    shortId: string,
    input: IngestionInput,
    sourceManifest?: string,
  ) {
    const [row] = await this.db.query(
      'SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3',
      this.args(scope, shortId),
    );
    const record: ShortRecord = row?.body;
    if (
      !record ||
      record.publication !== 'published' ||
      !officialContentPolicy(record).serve
    )
      throw new ConflictException(
        'Original Short is not eligible for replacement preparation',
      );
    const source = shortsDeliverySource(record);
    assertDeliverySourcePreparation(source);
    if (
      input.processingProfile !== 'original-h264-v1' ||
      input.sha256 !== source.sha256 ||
      input.bytes !== source.bytes
    )
      throw new ConflictException(
        'Replacement preparation must use the exact original',
      );
    return this.metadata.enqueue(
      scope,
      jobId,
      record.creator,
      input,
      undefined,
      shortId,
      sourceManifest,
    );
  }
  async get(scope: ShortsScope, jobId: string) {
    const [row] = await this.db.query(
      `SELECT g.short_id,g.fence,g.body,c.body AS canonical FROM shorts_delivery_generations g JOIN shorts_content c
        ON c.network=g.network AND c.contract=g.contract AND c.id=g.short_id
        WHERE g.network=$1 AND g.contract=$2 AND g.job_id=$3`,
      this.args(scope, jobId),
    );
    if (!row)
      throw new NotFoundException('Delivery generation is not prepared');
    const record: ShortRecord = row.body;
    if (
      !validateOriginalContent(record) ||
      record.id !== jobId ||
      record.derivatives.generation.fence !== String(row.fence)
    )
      throw new ConflictException('Invalid prepared delivery generation');
    const descriptor = {
      ...shortsPlaybackDescriptor(record, scope, row.canonical),
      id: row.short_id,
    };
    return {
      shortId: row.short_id as string,
      record,
      descriptor,
      sourceKey: sourceKey(descriptor),
    };
  }
}
