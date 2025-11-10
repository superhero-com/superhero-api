import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { CoinHistoricalPrice } from '../entities/coin-historical-price.entity';

@Injectable()
export class CoinHistoricalPriceService {
  private readonly logger = new Logger(CoinHistoricalPriceService.name);

  constructor(
    @InjectRepository(CoinHistoricalPrice)
    private readonly repository: Repository<CoinHistoricalPrice>,
  ) {}

  /**
   * Get historical price data from database for a given time range
   * @param coinId - The coin ID (e.g., 'aeternity')
   * @param currency - The currency code (e.g., 'usd')
   * @param startTimeMs - Start timestamp in milliseconds
   * @param endTimeMs - End timestamp in milliseconds
   * @returns Array of [timestamp_ms, price] pairs
   */
  async getHistoricalPriceData(
    coinId: string,
    currency: string,
    startTimeMs: number,
    endTimeMs: number,
  ): Promise<Array<[number, number]>> {
    try {
      const records = await this.repository.find({
        where: {
          coin_id: coinId,
          currency: currency,
          timestamp_ms: Between(startTimeMs, endTimeMs),
        },
        order: {
          timestamp_ms: 'ASC',
        },
      });

      return records.map((record) => [
        record.timestamp_ms,
        Number(record.price),
      ]);
    } catch (error) {
      this.logger.error(
        `Failed to get historical price data from database:`,
        error,
      );
      return [];
    }
  }

  /**
   * Get the most recent timestamp in the database for a coin/currency pair
   * @param coinId - The coin ID
   * @param currency - The currency code
   * @returns Most recent timestamp in milliseconds, or null if no data exists
   */
  async getLatestTimestamp(
    coinId: string,
    currency: string,
  ): Promise<number | null> {
    try {
      const latest = await this.repository.findOne({
        where: {
          coin_id: coinId,
          currency: currency,
        },
        order: {
          timestamp_ms: 'DESC',
        },
        select: ['timestamp_ms'],
      });

      return latest?.timestamp_ms || null;
    } catch (error) {
      this.logger.error(`Failed to get latest timestamp:`, error);
      return null;
    }
  }

  /**
   * Get the oldest timestamp in the database for a coin/currency pair
   * @param coinId - The coin ID
   * @param currency - The currency code
   * @returns Oldest timestamp in milliseconds, or null if no data exists
   */
  async getOldestTimestamp(
    coinId: string,
    currency: string,
  ): Promise<number | null> {
    try {
      const oldest = await this.repository.findOne({
        where: {
          coin_id: coinId,
          currency: currency,
        },
        order: {
          timestamp_ms: 'ASC',
        },
        select: ['timestamp_ms'],
      });

      return oldest?.timestamp_ms || null;
    } catch (error) {
      this.logger.error(`Failed to get oldest timestamp:`, error);
      return null;
    }
  }

  /**
   * Save price data points to database (bulk insert)
   * @param coinId - The coin ID
   * @param currency - The currency code
   * @param priceData - Array of [timestamp_ms, price] pairs
   */
  async savePriceData(
    coinId: string,
    currency: string,
    priceData: Array<[number, number]>,
  ): Promise<void> {
    if (priceData.length === 0) {
      return;
    }

    try {
      // Check for existing records to avoid duplicates
      const timestamps = priceData.map(([timestamp]) => timestamp);
      const existing = await this.repository.find({
        where: {
          coin_id: coinId,
          currency: currency,
          timestamp_ms: Between(
            Math.min(...timestamps),
            Math.max(...timestamps),
          ),
        },
        select: ['timestamp_ms'],
      });

      const existingTimestamps = new Set(
        existing.map((record) => record.timestamp_ms),
      );

      // Filter out duplicates
      const newData = priceData.filter(
        ([timestamp]) => !existingTimestamps.has(timestamp),
      );

      if (newData.length === 0) {
        this.logger.debug(
          `All ${priceData.length} price points already exist in database`,
        );
        return;
      }

      // Prepare entities for bulk insert
      const entities = newData.map(([timestamp_ms, price]) => {
        const entity = new CoinHistoricalPrice();
        entity.coin_id = coinId;
        entity.currency = currency;
        entity.timestamp_ms = timestamp_ms;
        entity.price = price;
        return entity;
      });

      // Bulk insert in chunks to avoid query size limits
      const chunkSize = 1000;
      for (let i = 0; i < entities.length; i += chunkSize) {
        const chunk = entities.slice(i, i + chunkSize);
        await this.repository.save(chunk);
      }

      this.logger.log(
        `Saved ${newData.length} new price points to database (${priceData.length} total, ${priceData.length - newData.length} duplicates skipped)`,
      );
    } catch (error) {
      this.logger.error(`Failed to save price data to database:`, error);
      throw error;
    }
  }

  /**
   * Identify missing data ranges in the database
   * @param coinId - The coin ID
   * @param currency - The currency code
   * @param requestedStartMs - Requested start timestamp
   * @param requestedEndMs - Requested end timestamp
   * @returns Array of [startMs, endMs] pairs representing missing ranges
   */
  async getMissingDataRanges(
    coinId: string,
    currency: string,
    requestedStartMs: number,
    requestedEndMs: number,
  ): Promise<Array<[number, number]>> {
    try {
      // Get all existing timestamps in the requested range
      const existing = await this.repository.find({
        where: {
          coin_id: coinId,
          currency: currency,
          timestamp_ms: Between(requestedStartMs, requestedEndMs),
        },
        order: {
          timestamp_ms: 'ASC',
        },
        select: ['timestamp_ms'],
      });

      if (existing.length === 0) {
        // No data exists, entire range is missing
        return [[requestedStartMs, requestedEndMs]];
      }

      const existingTimestamps = existing.map((r) => r.timestamp_ms);
      const missingRanges: Array<[number, number]> = [];

      // Check gap at the beginning
      if (existingTimestamps[0] > requestedStartMs) {
        missingRanges.push([requestedStartMs, existingTimestamps[0] - 1]);
      }

      // Check gaps between existing timestamps
      for (let i = 0; i < existingTimestamps.length - 1; i++) {
        const gap = existingTimestamps[i + 1] - existingTimestamps[i];
        // If gap is larger than 1 hour (3600000 ms), consider it a missing range
        // This accounts for different data granularities (minute, hourly, daily)
        if (gap > 3600000) {
          missingRanges.push([
            existingTimestamps[i] + 1,
            existingTimestamps[i + 1] - 1,
          ]);
        }
      }

      // Check gap at the end
      if (
        existingTimestamps[existingTimestamps.length - 1] < requestedEndMs
      ) {
        missingRanges.push([
          existingTimestamps[existingTimestamps.length - 1] + 1,
          requestedEndMs,
        ]);
      }

      return missingRanges;
    } catch (error) {
      this.logger.error(`Failed to identify missing data ranges:`, error);
      // On error, assume entire range is missing
      return [[requestedStartMs, requestedEndMs]];
    }
  }

  /**
   * Merge and deduplicate price data arrays
   * @param existing - Existing price data from database
   * @param newData - Newly fetched price data
   * @returns Merged and sorted array of [timestamp_ms, price] pairs
   */
  mergePriceData(
    existing: Array<[number, number]>,
    newData: Array<[number, number]>,
  ): Array<[number, number]> {
    // Combine both arrays
    const combined = [...existing, ...newData];

    // Create a Map to deduplicate by timestamp (newer data takes precedence)
    const mergedMap = new Map<number, number>();
    for (const [timestamp, price] of combined) {
      // If timestamp already exists, keep the newer one (from newData)
      if (!mergedMap.has(timestamp) || newData.some(([t]) => t === timestamp)) {
        mergedMap.set(timestamp, price);
      }
    }

    // Convert back to array and sort by timestamp
    const merged = Array.from(mergedMap.entries()).sort(
      (a, b) => a[0] - b[0],
    );

    return merged;
  }
}

