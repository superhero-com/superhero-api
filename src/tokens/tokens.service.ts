import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Token } from './entities/token.entity';
import { TokenHistory } from './entities/token-history.entity';

@Injectable()
export class TokensService {
  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(TokenHistory)
    private tokenHistoriesRepository: Repository<TokenHistory>,
  ) {
    console.log('TokensService created');
  }

  findAll(): Promise<Token[]> {
    return this.tokensRepository.find();
  }

  findByAddress(address: string): Promise<Token | null> {
    return this.tokensRepository
      .createQueryBuilder('token')
      .where('token.address = :address', { address })
      .orWhere('token.sale_address = :address', { address })
      .getOne();
  }

  findOne(id: number): Promise<Token | null> {
    return this.tokensRepository.findOneBy({ id });
  }

  async remove(id: number): Promise<void> {
    await this.tokensRepository.delete(id);
  }

  async save(token: Partial<Token>) {
    console.log('++saveNewToken', token.name);
    const tokenExists = await this.tokensRepository.findOneBy({
      sale_address: token.sale_address,
    });

    if (tokenExists) {
      return;
    }

    this.tokensRepository.save(token);
  }

  async update(sale_address, data: Partial<Token>) {
    const tokenExists = await this.tokensRepository.findOneBy({
      sale_address,
    });

    if (!tokenExists) {
      return;
    }
    const result = await this.tokensRepository.update(tokenExists.id, data);

    console.log('==========');
    console.log('update', result);
    if (data.price) {
      this.tokenHistoriesRepository.save({
        sale_address,
        price: data.price,
        sell_price: data.sell_price,
        market_cap: data.market_cap,
        total_supply: data.total_supply,
      });
    }
  }
}
