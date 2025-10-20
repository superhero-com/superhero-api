import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PairSummary } from '../entities/pair-summary.entity';
import { Pair } from '../entities/pair.entity';
import { PairHistoryService } from './pair-history.service';

@Injectable()
export class PairSummaryService {
  constructor(
    @InjectRepository(PairSummary)
    private readonly pairSummaryRepository: Repository<PairSummary>,

    private pairHistoryService: PairHistoryService,
  ) {}

  async createOrUpdateSummary(pair: Pair): Promise<PairSummary> {
    const summaryData =
      await this.pairHistoryService.calculatePairSummary(pair);
    const existingSummary = await this.pairSummaryRepository.findOne({
      where: { pair_address: pair.address },
    });

    if (existingSummary) {
      // Update existing summary
      existingSummary.volume_token = summaryData.volume_token;
      existingSummary.token_position = summaryData.token_position;
      existingSummary.total_volume = summaryData.total_volume;
      existingSummary.change_24h = summaryData.change['24h'];
      existingSummary.change_7d = summaryData.change['7d'];
      existingSummary.change_30d = summaryData.change['30d'];

      return this.pairSummaryRepository.save(existingSummary);
    } else {
      // Create new summary
      const newSummary = this.pairSummaryRepository.create({
        pair_address: pair.address,
        volume_token: summaryData.volume_token,
        token_position: summaryData.token_position,
        total_volume: summaryData.total_volume,
        change_24h: summaryData.change['24h'],
        change_7d: summaryData.change['7d'],
        change_30d: summaryData.change['30d'],
      });

      return this.pairSummaryRepository.save(newSummary);
    }
  }

  async getSummaryByPairAddress(
    pairAddress: string,
  ): Promise<PairSummary | null> {
    return this.pairSummaryRepository.findOne({
      where: { pair_address: pairAddress },
    });
  }

  async deleteSummary(pairAddress: string): Promise<void> {
    await this.pairSummaryRepository.delete({ pair_address: pairAddress });
  }

  async getAllSummaries(): Promise<PairSummary[]> {
    return this.pairSummaryRepository.find();
  }
}
