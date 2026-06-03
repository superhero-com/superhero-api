import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from '@/account/entities/account.entity';
import { shortenAddress } from '../notifications.constants';

/**
 * Resolves a human-friendly label for an address (its `.chain` name when known,
 * otherwise a shortened address). Best-effort: never throws, since it only enriches
 * notification copy.
 */
@Injectable()
export class AccountLabelService {
  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
  ) {}

  async labelFor(address: string): Promise<string> {
    try {
      const account = await this.accountRepository.findOne({
        where: { address },
        select: ['address', 'chain_name'],
      });
      if (account?.chain_name) {
        return account.chain_name;
      }
    } catch {
      // fall through to shortened address
    }
    return shortenAddress(address);
  }
}
