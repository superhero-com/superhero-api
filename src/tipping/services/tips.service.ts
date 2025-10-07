import { Account } from '@/account/entities/account.entity';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tip } from '../entities/tip.entity';

@Injectable()
export class TipService {
  private readonly logger = new Logger(TipService.name);
  private readonly isProcessing = new Map<string, boolean>();

  constructor(
    @InjectRepository(Tip)
    private readonly tipRepository: Repository<Tip>,

    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
  ) {
    this.logger.log('TipService initialized');
  }

  // async onModuleInit(): Promise<void> {
  //   //
  // }
}
