import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { BclToken } from '../entities/bcl-token.entity';
import moment from 'moment';

@Injectable()
export class BclTokenPersistenceService {
  private readonly logger = new Logger(BclTokenPersistenceService.name);

  constructor(
    @InjectRepository(BclToken)
    private readonly bclTokenRepository: Repository<BclToken>,
  ) { }

  /**
   * Save BCL token record from create_community transaction
   * @param tx - Raw transaction entity
   * @param manager - Optional entity manager for transaction context
   * @returns Saved BCL token entity
   */
  async saveBclToken(
    tx: Tx,
    txData: any,
    manager?: EntityManager,
  ): Promise<void> {
    const repository = manager
      ? manager.getRepository(BclToken)
      : this.bclTokenRepository;


    // Prepare BCL token data
    const bclTokenData: Partial<BclToken> = {
      ...txData,
      created_at: tx.created_at,
      create_tx_hash: tx.hash,
    };

    await repository.upsert(bclTokenData, {
      conflictPaths: ['sale_address'],
    });
  }
}

