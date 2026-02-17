import { recordSyncTokenHoldersDuration } from '@/utils/stabilization-metrics';
import { Encoded } from '@aeternity/aepp-sdk';
import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { TokensService } from '../tokens.service';
import { SYNC_TOKEN_HOLDERS_QUEUE } from './constants';

export interface ISyncTokenHoldersQueue {
  saleAddress: Encoded.ContractAddress;
}

@Processor(SYNC_TOKEN_HOLDERS_QUEUE)
export class SyncTokenHoldersQueue {
  private readonly logger = new Logger(SyncTokenHoldersQueue.name);
  private readonly jobTimeoutMs = Number(
    process.env.SYNC_TOKEN_HOLDERS_JOB_TIMEOUT_MS || 180_000,
  );
  private readonly inFlightSyncs = new Map<string, Promise<void>>();
  private readonly inFlightStartedAt = new Map<string, number>();

  constructor(private tokenService: TokensService) {
    //
  }

  /**
   * @param job
   */
  @Process({
    concurrency: 10,
  })
  async process(job: Job<ISyncTokenHoldersQueue>) {
    const saleAddress = job.data.saleAddress;
    this.logger.log(`SyncTokenHoldersQueue->started:${saleAddress}`);

    const runningSync = this.inFlightSyncs.get(saleAddress);
    if (runningSync) {
      const runningSince =
        this.inFlightStartedAt.get(saleAddress) ?? Date.now();
      this.logger.warn(
        `SyncTokenHoldersQueue->join-inflight:${saleAddress} (${Date.now() - runningSince}ms running)`,
      );
      let joinTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          runningSync,
          new Promise<void>((_, reject) => {
            joinTimeoutHandle = setTimeout(
              () =>
                reject(
                  new Error(
                    `SyncTokenHoldersQueue join-inflight timeout after ${this.jobTimeoutMs}ms`,
                  ),
                ),
              this.jobTimeoutMs,
            );
          }),
        ]);
      } catch (joinError: any) {
        this.inFlightSyncs.delete(saleAddress);
        this.inFlightStartedAt.delete(saleAddress);
        throw joinError;
      } finally {
        if (joinTimeoutHandle) clearTimeout(joinTimeoutHandle);
      }
      return;
    }

    const startedAt = Date.now();
    const syncPromise = this.tokenService
      .loadAndSaveTokenHoldersFromMdw(saleAddress)
      .finally(() => {
        if (this.inFlightSyncs.get(saleAddress) === syncPromise) {
          this.inFlightSyncs.delete(saleAddress);
          this.inFlightStartedAt.delete(saleAddress);
        }
      });

    this.inFlightSyncs.set(saleAddress, syncPromise);
    this.inFlightStartedAt.set(saleAddress, startedAt);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        syncPromise,
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(
            () =>
              reject(
                new Error(
                  `SyncTokenHoldersQueue timeout after ${this.jobTimeoutMs}ms`,
                ),
              ),
            this.jobTimeoutMs,
          );
        }),
      ]);
      const durationMs = Date.now() - startedAt;
      recordSyncTokenHoldersDuration(durationMs);
      this.logger.debug(
        `SyncTokenHoldersQueue->completed:${saleAddress} (${durationMs}ms)`,
      );
    } catch (error: any) {
      if (this.inFlightSyncs.get(saleAddress) === syncPromise) {
        this.inFlightSyncs.delete(saleAddress);
        this.inFlightStartedAt.delete(saleAddress);
      }
      this.logger.error(
        `SyncTokenHoldersQueue->error:${saleAddress} (${Date.now() - startedAt}ms)`,
        error,
        error.stack,
      );
      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
