import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Token } from './entities/token.entity';
import { Encoded } from '@aeternity/aepp-sdk';

@Injectable()
export class TokensService {
  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,
  ) {
    console.log('TokensService created');
  }

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

  async save(token: {
    name: string;
    address: Encoded.ContractAddress;
    factory_address: Encoded.ContractAddress;
  }) {
    console.log('++saveNewToken', token.name);
    const tokenExists = await this.tokensRepository.findOneBy({
      address: token.address,
    });

    if (tokenExists) {
      return;
    }

    this.tokensRepository.save(token);
  }
}
