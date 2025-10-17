/**
 * Example usage of PairSummary functionality
 * 
 * This example demonstrates how to:
 * 1. Get pair data with pre-calculated summary data via left join
 * 2. Use cached summary data for better performance
 * 3. Force recalculation of summary data when needed
 */

import { Injectable } from '@nestjs/common';
import { PairService } from '../services/pair.service';
import { PairHistoryService } from '../services/pair-history.service';
import { PairSummaryService } from '../services/pair-summary.service';

@Injectable()
export class PairSummaryUsageExample {
  constructor(
    private readonly pairService: PairService,
    private readonly pairHistoryService: PairHistoryService,
    private readonly pairSummaryService: PairSummaryService,
  ) {}

  /**
   * Example 1: Get all pairs with their summary data (using left join)
   * This will include the summary data if it exists, or null if not cached
   */
  async getAllPairsWithSummary() {
    const pairs = await this.pairService.findAll({
      page: 1,
      limit: 10,
    });

    // Each pair will now have a 'summary' property with cached data
    pairs.items.forEach(pair => {
      if (pair.summary) {
        console.log(`Pair ${pair.address} has cached summary:`, {
          total_volume: pair.summary.total_volume,
          change_24h: pair.summary.change_24h,
          change_7d: pair.summary.change_7d,
          change_30d: pair.summary.change_30d,
        });
      } else {
        console.log(`Pair ${pair.address} has no cached summary`);
      }
    });

    return pairs;
  }

  /**
   * Example 2: Get specific pair with summary data
   */
  async getPairWithSummary(pairAddress: string) {
    const pair = await this.pairService.findByAddress(pairAddress);
    
    if (pair?.summary) {
      console.log('Using cached summary data');
      return {
        pair,
        summary: {
          total_volume: pair.summary.total_volume,
          change: {
            '24h': pair.summary.change_24h,
            '7d': pair.summary.change_7d,
            '30d': pair.summary.change_30d,
          },
        },
      };
    }

    return null;
  }

  /**
   * Example 3: Get pair summary with caching (default behavior)
   */
  async getPairSummaryCached(pairAddress: string, token?: string) {
    const pair = await this.pairService.findByAddress(pairAddress);
    if (!pair) return null;

    // This will use cached data if available, or calculate and cache new data
    return await this.pairHistoryService.getPairSummary(pair, token, true);
  }

  /**
   * Example 4: Force recalculation of pair summary
   */
  async refreshPairSummary(pairAddress: string, token?: string) {
    const pair = await this.pairService.findByAddress(pairAddress);
    if (!pair) return null;

    // Force recalculation by setting useCache to false
    return await this.pairHistoryService.getPairSummary(pair, token, false);
  }

  /**
   * Example 5: Manually manage summary data
   */
  async manageSummaryData(pairAddress: string) {
    // Get existing summary
    const existingSummary = await this.pairSummaryService.getSummaryByPairAddress(pairAddress);
    
    if (existingSummary) {
      console.log('Found existing summary:', existingSummary);
      
      // Update the summary (this would typically be done by the calculation service)
      // existingSummary.total_volume = newVolumeData;
      // await this.pairSummaryService.createOrUpdateSummary(pair, updatedSummary);
    } else {
      console.log('No cached summary found for pair:', pairAddress);
    }

    // Delete summary if needed
    // await this.pairSummaryService.deleteSummary(pairAddress);
  }

  /**
   * Example 6: Batch operations for multiple pairs
   */
  async getMultiplePairsWithSummary(pairAddresses: string[]) {
    const results = [];
    
    for (const address of pairAddresses) {
      const pair = await this.pairService.findByAddress(address);
      if (pair) {
        results.push({
          address: pair.address,
          hasCachedSummary: !!pair.summary,
          summary: pair.summary,
        });
      }
    }
    
    return results;
  }
}
