import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Token } from '@/tokens/entities/token.entity';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { TokensService } from '@/tokens/tokens.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { BCL_FUNCTIONS } from '@/configs';
import { Encoded, toAe } from '@aeternity/aepp-sdk';
import BigNumber from 'bignumber.js';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly communityFactoryService: CommunityFactoryService,
    private readonly tokenService: TokensService,
    @InjectRepository(TokenHolder)
    private tokenHolderRepository: Repository<TokenHolder>,
  ) {}

  /**
   * Decode transaction events from a Tx entity
   */
  async decodeTxEvents(
    token: Token,
    tx: Tx,
    retries = 0,
  ): Promise<Tx> {
    try {
      const factory = await this.communityFactoryService.loadFactory(
        token.factory_address as Encoded.ContractAddress,
      );
      const decodedData = factory.contract.$decodeEvents(tx.raw?.log || []);

      return {
        ...tx,
        raw: {
          ...tx.raw,
          decodedData,
        },
      };
    } catch (error: any) {
      if (retries < 3) {
        return this.decodeTxEvents(token, tx, retries + 1);
      }
      this.logger.error(
        `decodeTxEvents->error:: retry ${retries}/3`,
        error,
        error.stack,
      );
      return tx;
    }
  }

  /**
   * Parse transaction data from a Tx entity
   */
  async parseTransactionData(tx: Tx): Promise<{
    volume: BigNumber;
    amount: BigNumber;
    total_supply: BigNumber;
    protocol_reward: BigNumber;
    _should_revalidate: boolean;
  }> {
    const decodedData = tx.raw?.decodedData;
    let volume = new BigNumber(0);
    let amount = new BigNumber(0);
    let total_supply = new BigNumber(0);
    let protocol_reward = new BigNumber(0);

    if (!decodedData || decodedData.length == 0) {
      return {
        volume,
        amount,
        total_supply,
        protocol_reward,
        _should_revalidate: true,
      };
    }

    if (tx.function === BCL_FUNCTIONS.buy) {
      const mints = decodedData.filter((data) => data.name === 'Mint');
      protocol_reward = new BigNumber(toAe(mints[0].args[1]));
      volume = new BigNumber(toAe(mints[mints.length - 1].args[1]));
      amount = new BigNumber(
        toAe(decodedData.find((data) => data.name === 'Buy').args[0]),
      );
      total_supply = new BigNumber(
        toAe(decodedData.find((data) => data.name === 'Buy').args[2]),
      ).plus(volume);
    }

    if (tx.function === BCL_FUNCTIONS.create_community) {
      if (decodedData.find((data) => data.name === 'PriceChange')) {
        const mints = decodedData.filter((data) => data.name === 'Mint');
        protocol_reward = new BigNumber(toAe(mints[0].args[1]));
        volume = new BigNumber(toAe(mints[mints.length - 1].args[1]));
        amount = new BigNumber(
          toAe(decodedData.find((data) => data.name === 'Buy').args[0]),
        );
        total_supply = new BigNumber(
          toAe(decodedData.find((data) => data.name === 'Buy').args[2]),
        ).plus(volume);
      }
    }

    if (tx.function === BCL_FUNCTIONS.sell) {
      volume = new BigNumber(
        toAe(decodedData.find((data) => data.name === 'Burn').args[1]),
      );
      amount = new BigNumber(
        toAe(decodedData.find((data) => data.name === 'Sell').args[0]),
      );
      total_supply = new BigNumber(
        toAe(decodedData.find((data) => data.name === 'Sell').args[1]),
      ).minus(volume);
    }

    return {
      volume,
      amount,
      total_supply,
      protocol_reward,
      _should_revalidate: false,
    };
  }

  /**
   * Checks if the given token is part of a supported collection.
   */
  async isTokenSupportedCollection(token: Token): Promise<boolean> {
    const factory = await this.communityFactoryService.getCurrentFactory();

    if (token.factory_address !== factory.address) {
      return false;
    }

    if (!Object.keys(factory.collections).includes(token.collection)) {
      return false;
    }

    return true;
  }

  /**
   * Update token holder based on transaction
   */
  async updateTokenHolder(
    token: Token,
    tx: Tx,
    volume: BigNumber,
    manager?: EntityManager,
  ): Promise<void> {
    try {
      const bigNumberVolume = new BigNumber(volume).multipliedBy(10 ** 18);
      const repository = manager?.getRepository(TokenHolder) || this.tokenHolderRepository;
      
      const tokenHolderCount = await repository
        .createQueryBuilder('token_holders')
        .where('token_holders.aex9_address = :aex9_address', {
          aex9_address: token.address,
        })
        .getCount();

      const tokenHolder = await repository
        .createQueryBuilder('token_holders')
        .where('token_holders.aex9_address = :aex9_address', {
          aex9_address: token.address,
        })
        .andWhere('token_holders.address = :address', {
          address: tx.caller_id,
        })
        .getOne();

      if (tokenHolder) {
        let tokenHolderBalance = tokenHolder.balance;
        // if balance is negative, set it to 0
        if (tokenHolderBalance.isNegative()) {
          tokenHolderBalance = new BigNumber(0);
        }
        // if is buy
        if (tx.function === BCL_FUNCTIONS.buy) {
          await repository.update(tokenHolder.id, {
            balance: tokenHolderBalance.plus(bigNumberVolume),
            last_tx_hash: tx.hash,
            block_number: tx.block_height,
          });
        }
        // if is sell
        if (tx.function === BCL_FUNCTIONS.sell) {
          await repository.update(tokenHolder.id, {
            balance: tokenHolderBalance.minus(bigNumberVolume),
            last_tx_hash: tx.hash,
            block_number: tx.block_height,
          });
        }
        if (token.holders_count == 0) {
          if (manager) {
            await manager.getRepository(Token).update(token.sale_address, {
              holders_count: 1,
            });
          } else {
            await this.tokenService.update(token, {
              holders_count: 1,
            });
          }
        }
      } else {
        // create token holder
        await repository.save({
          id: `${tx.caller_id}_${token.address}`,
          aex9_address: token.address,
          address: tx.caller_id,
          balance: bigNumberVolume,
          last_tx_hash: tx.hash,
          block_number: tx.block_height,
        });
        // increment token holders count
        if (manager) {
          await manager.getRepository(Token).update(token.sale_address, {
            holders_count: tokenHolderCount + 1,
          });
        } else {
          await this.tokenService.update(token, {
            holders_count: tokenHolderCount + 1,
          });
        }
      }
    } catch (error) {
      this.logger.error('Error updating token holder', error);
    }
    // Background operation - keep outside transaction
    if (!manager) {
      try {
        await this.tokenService.loadAndSaveTokenHoldersFromMdw(
          token.sale_address as Encoded.ContractAddress,
        );
      } catch (error: any) {
        this.logger.error(
          `Error loading and saving token holders from mdw`,
          error,
          error.stack,
        );
      }
    }
  }
}

