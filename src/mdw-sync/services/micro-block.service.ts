import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { fetchJson } from '@/utils/common';
import { MicroBlock } from '../entities/micro-block.entity';

@Injectable()
export class MicroBlockService {
  private readonly logger = new Logger(MicroBlockService.name);

  constructor(
    @InjectRepository(MicroBlock)
    private microBlockRepository: Repository<MicroBlock>,
    private configService: ConfigService,
  ) {}

  /**
   * Convert raw micro-block data from MDW API to entity format
   */
  convertToMicroBlockEntity(
    microBlock: any,
    fallbackHeight?: number,
  ): Partial<MicroBlock> {
    return {
      hash: microBlock.hash,
      height: microBlock.height || fallbackHeight,
      prev_hash: microBlock.prev_hash,
      prev_key_hash: microBlock.prev_key_hash,
      state_hash: microBlock.state_hash,
      time: microBlock.time.toString(),
      transactions_count: microBlock.transactions_count,
      flags: microBlock.flags,
      version: microBlock.version,
      gas: microBlock.gas,
      micro_block_index: microBlock.micro_block_index,
      pof_hash: microBlock.pof_hash,
      signature: microBlock.signature,
      txs_hash: microBlock.txs_hash,
      created_at: new Date(microBlock.time),
    };
  }

  /**
   * Ensure micro-block exists in database, fetching and saving if needed
   */
  async ensureMicroBlockExists(
    microBlockHash: string,
    fallbackHeight?: number,
  ): Promise<boolean> {
    try {
      // Check if micro-block already exists
      const existingMicroBlock = await this.microBlockRepository.findOne({
        where: { hash: microBlockHash },
      });

      if (existingMicroBlock) {
        return true; // Already exists
      }

      // Fetch micro-block from MDW
      const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');
      const microBlock = await fetchJson(
        `${middlewareUrl}/v3/micro-blocks/${microBlockHash}`,
      );

      if (!microBlock) {
        this.logger.error(
          `Micro-block not found in MDW: ${microBlockHash}. This may indicate a synchronization issue.`,
        );
        return false;
      }

      // Convert and upsert micro-block (handles race conditions where multiple
      // transactions from the same micro-block arrive simultaneously)
      const microBlockToSave = this.convertToMicroBlockEntity(
        microBlock,
        fallbackHeight,
      );
      await this.microBlockRepository.upsert(microBlockToSave, {
        conflictPaths: ['hash'],
        skipUpdateIfNoValuesChanged: true,
      });
      this.logger.debug(
        `Saved micro-block ${microBlockHash} before transaction`,
      );
      return true;
    } catch (error: any) {
      this.logger.error(
        `Failed to ensure micro-block exists ${microBlockHash}: ${error.message}`,
        error.stack,
      );
      return false;
    }
  }

  /**
   * Fetch micro-blocks for a key-block (handles pagination)
   */
  async fetchMicroBlocksForKeyBlock(
    keyBlockHash: string,
  ): Promise<Partial<MicroBlock>[]> {
    const microBlocksToSave: Partial<MicroBlock>[] = [];
    const middlewareUrl = this.configService.get<string>('mdw.middlewareUrl');
    let microBlocksUrl: string | null = `${middlewareUrl}/v3/key-blocks/${keyBlockHash}/micro-blocks?limit=100`;

    // A single key block realistically contains at most a few hundred micro-blocks.
    // Cap at 1 000 pages as a safety guard against a runaway pagination response.
    const maxPages = 1_000;
    let pageCount = 0;

    // Handle pagination
    while (microBlocksUrl) {
      if (++pageCount > maxPages) {
        this.logger.warn(
          `fetchMicroBlocksForKeyBlock: exceeded max pages (${maxPages}) for key block ${keyBlockHash}, stopping pagination`,
        );
        break;
      }

      const response = await fetchJson(microBlocksUrl);
      const microBlocks = response?.data || [];

      // Convert micro-blocks to entity format
      for (const microBlock of microBlocks) {
        microBlocksToSave.push(
          this.convertToMicroBlockEntity(microBlock),
        );
      }

      // Check if there's a next page
      microBlocksUrl = response?.next
        ? `${middlewareUrl}${response.next}`
        : null;
    }

    return microBlocksToSave;
  }
}

