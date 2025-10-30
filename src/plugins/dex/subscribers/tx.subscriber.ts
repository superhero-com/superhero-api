import {
  EntitySubscriberInterface,
  EventSubscriber,
  InsertEvent,
} from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';

@EventSubscriber()
export class TxSubscriber implements EntitySubscriberInterface<Tx> {
  listenTo() {
    return Tx;
  }

  async afterInsert(event: InsertEvent<Tx>) {
    const entity = event.entity;
    console.log('Tx inserted', entity);
  }
}
