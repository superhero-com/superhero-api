import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '../entities/tx.entity';

@Injectable()
export class TxSyncService {
  private readonly logger = new Logger(TxSyncService.name);

  constructor(
    @InjectRepository(Tx)
    private readonly txRepository: Repository<Tx>,
  ) {
    this.logger.log('TxSyncService initialized');
  }

  // async onModuleInit(): Promise<void> {
  //   //
  // }
}
