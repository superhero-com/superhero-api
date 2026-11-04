import { Injectable, Optional } from '@nestjs/common';
import { ShortsMediaService } from './shorts-media.service';
import { ShortsDeliveryPackagesService } from './shorts-delivery-packages.service';
import { ShortsPinTransfersService } from './shorts-pin-transfers.service';
import { ShortRecord } from './shorts.types';
import { PlaybackDescriptor } from './hls-protocol/playback-descriptor';
import {
  HlsPackage,
  sourceKey,
  validateSourcePackage,
} from './hls-protocol/hls-package';

/** Adopt a physically verified HLS pin under fresh authority, including old cache entries. */
@Injectable()
export class ShortsDeliveryAcknowledgementService {
  constructor(
    private readonly media: ShortsMediaService,
    private readonly packages: ShortsDeliveryPackagesService,
    @Optional() private readonly transfers?: ShortsPinTransfersService,
  ) {}
  async acknowledge(
    record: ShortRecord,
    descriptor: PlaybackDescriptor,
    value: HlsPackage,
    recheck: () => Promise<unknown>,
    signal: AbortSignal,
  ) {
    const prepared = validateSourcePackage(descriptor, value);
    if (process.env.SHORTS_IPFS_EXPIRING_WRITES !== 'true') {
      if (!descriptor.original) {
        await recheck();
        await this.media.verifyDurableDelivery(
          record,
          descriptor,
          prepared,
          signal,
        );
        await recheck();
        signal.throwIfAborted();
      }
      return this.packages.acknowledge(descriptor, prepared);
    }
    if (!this.transfers) throw new Error('Delivery pin authority unavailable');
    const existing = await this.packages.get(descriptor);
    if (existing) {
      await recheck();
      await this.media[
        descriptor.original ? 'verifyPreparedDelivery' : 'verifyDurableDelivery'
      ](record, descriptor, prepared, signal);
      await recheck();
      signal.throwIfAborted();
      return this.packages.acknowledge(descriptor, prepared);
    }
    signal.throwIfAborted();
    const pin = await this.transfers.begin(
      { network: descriptor.network!, contract: descriptor.contract! },
      {
        cid: prepared.cid,
        jobId: descriptor.id,
        purpose: 'hls',
        sourceKey: sourceKey(descriptor),
      },
    );
    try {
      await recheck();
      signal.throwIfAborted();
      await this.media[
        descriptor.original ? 'verifyPreparedDelivery' : 'verifyDurableDelivery'
      ](record, descriptor, prepared, signal);
      await recheck();
      signal.throwIfAborted();
      await this.packages.acknowledge(descriptor, prepared, pin.operationId);
    } catch (error) {
      // Adoption only reads storage. An interrupted SQL commit remains either
      // issued or atomically pinned with the durable package; never erase it.
      await this.transfers.finish(pin.operationId, 'rejected').catch(() => {});
      throw error;
    }
  }
}
