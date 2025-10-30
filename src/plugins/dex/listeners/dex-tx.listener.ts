import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class DexTxListener {
  //   constructor(@InjectRepository(YourOtherEntity) private repo: Repository<YourOtherEntity>) {}

  @OnEvent('tx.created', { async: true })
  async handleCreated(tx: Tx) {
    console.log('[DexTxListener] Tx created', tx);
  }
}
