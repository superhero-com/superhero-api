import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TokenHistory } from './entities/token-history.entity';
import { Token } from './entities/token.entity';

import { TokensGateway } from './tokens.gateway';

@Injectable()
export class TokensService {
  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(TokenHistory)
    private tokenHistoriesRepository: Repository<TokenHistory>,

    private tokensGateway: TokensGateway,
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
      .orWhere('token.name = :address', { address })
      .getOne();
  }

  findOne(id: number): Promise<Token | null> {
    return this.tokensRepository.findOneBy({ id });
  }

  async remove(id: number): Promise<void> {
    await this.tokensRepository.delete(id);
  }

  async save(token: Partial<Token>) {
    const tokenExists = await this.tokensRepository.findOneBy({
      sale_address: token.sale_address,
    });

    if (tokenExists) {
      return tokenExists;
    }

    return this.tokensRepository.save(token);
  }

  async checkIfTokenHasHistory(token: Token) {
    const tokenHistory = await this.tokenHistoriesRepository
      .createQueryBuilder('token_history')
      .where('token_history.tokenId = :tokenId', {
        tokenId: token.id,
      })
      .getExists();

    return tokenHistory;
  }

  async update(sale_address, data: Partial<Token>) {
    const tokenExists = await this.tokensRepository.findOneBy({
      sale_address,
    });

    if (!tokenExists) {
      return;
    }

    this.tokensRepository.update(tokenExists.id, data);

    this.tokensGateway?.handleTokenUpdate({
      sale_address,
      price: data.price,
      sell_price: data.sell_price,
      market_cap: data.market_cap,
      total_supply: data.total_supply,
    });

    if (data.price) {
      this.tokenHistoriesRepository.save({
        token: tokenExists,
        sale_address,
        price: data.price_data,
        sell_price: data.sell_price_data,
        market_cap: data.market_cap_data,
        total_supply: data.total_supply,
      });
    }

    this.updateTokensRanking();
  }

  async updateTokensRanking() {
    const tokens = await this.tokensRepository
      .createQueryBuilder('tokens')
      .orderBy('tokens.market_cap', 'DESC')
      .getMany();

    tokens.forEach((token, index) => {
      this.tokensRepository.update(token.id, { rank: index + 1 });
    });
  }
}
