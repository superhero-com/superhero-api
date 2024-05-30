import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Token } from './entities/token.entity';

@Injectable()
export class TokensService {
  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,
  ) {}

  findAll(): Promise<Token[]> {
    return this.tokensRepository.find();
  }

  findByAddress(address: string): Promise<Token | null> {
    return this.tokensRepository.findOneBy({ address });
  }

  findOne(id: number): Promise<Token | null> {
    return this.tokensRepository.findOneBy({ id });
  }

  async remove(id: number): Promise<void> {
    await this.tokensRepository.delete(id);
  }
}
