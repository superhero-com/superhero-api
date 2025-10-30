import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntitySubscriberInterface, InsertEvent } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class TxSubscriber
  implements EntitySubscriberInterface<Tx>, OnModuleInit
{
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly emitter: EventEmitter2,
  ) {}

  onModuleInit() {
    this.dataSource.subscribers.push(this);
  }

  listenTo() {
    return Tx;
  }

  async afterInsert(event: InsertEvent<Tx>) {
    this.emitter.emit('tx.created', event.entity);
  }
}
