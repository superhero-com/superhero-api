import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntitySubscriberInterface,
  InsertEvent,
  Repository,
} from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SyncState } from '../entities/sync-state.entity';

@Injectable()
export class TxSubscriber
  implements EntitySubscriberInterface<Tx>, OnModuleInit
{
  private bulkModeCache: boolean | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL_MS = 5000; // 5 seconds cache

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly emitter: EventEmitter2,
    @InjectRepository(SyncState)
    private readonly syncStateRepository: Repository<SyncState>,
  ) {}

  onModuleInit() {
    this.dataSource.subscribers.push(this);
    // Listen for bulk mode changes to invalidate cache
    this.emitter.on('sync.bulk-mode-changed', () => {
      this.bulkModeCache = null;
    });
  }

  listenTo() {
    return Tx;
  }

  async afterInsert(event: InsertEvent<Tx>) {
    // Check if we're in bulk mode - skip event emission during bulk sync
    // Use cached value to avoid DB query on every insert
    const now = Date.now();
    if (
      this.bulkModeCache === null ||
      now - this.cacheTimestamp > this.CACHE_TTL_MS
    ) {
      const syncState = await this.syncStateRepository.findOne({
        where: { id: 'global' },
        select: ['is_bulk_mode'],
      });
      this.bulkModeCache = syncState?.is_bulk_mode || false;
      this.cacheTimestamp = now;
    }

    if (this.bulkModeCache) {
      return; // Skip event emission during bulk sync
    }

    this.emitter.emit('tx.created', event.entity);
  }
}
