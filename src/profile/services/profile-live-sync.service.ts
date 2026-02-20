import { WebSocketService } from '@/ae/websocket.service';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ITransaction } from '@/utils/types';
import { PROFILE_MUTATION_FUNCTIONS } from '../profile.constants';
import { ProfileContractService } from './profile-contract.service';
import { ProfileIndexerService } from './profile-indexer.service';
import { ProfileXVerificationRewardService } from './profile-x-verification-reward.service';
import {
  extractProfileMutationCaller,
  extractProfileMutationContractId,
  extractProfileMutationFunction,
  extractProfileMutationPayload,
  extractProfileMutationRawLog,
  extractProfileMutationXUsername,
  isPendingProfileMutation,
  isSuccessfulProfileMutation,
} from './profile-mutation-tx.util';

@Injectable()
export class ProfileLiveSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProfileLiveSyncService.name);
  private unsubscribeTransactions: (() => void) | null = null;
  private readonly profileMutationFunctions = new Set<string>(
    PROFILE_MUTATION_FUNCTIONS,
  );
  private readonly recentTxHashes = new Map<
    string,
    { seenPending: boolean; seenConfirmed: boolean }
  >();
  private readonly recentTxHashQueue: string[] = [];
  private readonly maxRecentTxHashes = 500;
  private readonly autoRenamePossibleFunctions = new Set<string>([
    'set_chain_name',
    'set_x_name_with_attestation',
    'set_profile_full',
  ]);

  constructor(
    private readonly websocketService: WebSocketService,
    private readonly profileIndexerService: ProfileIndexerService,
    private readonly profileContractService: ProfileContractService,
    private readonly profileXVerificationRewardService: ProfileXVerificationRewardService,
  ) {}

  onModuleInit() {
    if (!this.profileContractService.isConfigured()) {
      this.logger.warn(
        'Profile contract is not configured, live sync disabled',
      );
      return;
    }
    this.unsubscribeTransactions =
      this.websocketService.subscribeForTransactionsUpdates(
        (transaction: ITransaction) => {
          this.handleTransaction(transaction).catch((error) => {
            this.logger.error(
              'Failed to process live profile transaction',
              error,
            );
          });
        },
      );
    this.logger.log('Profile live transaction subscription enabled');
  }

  onModuleDestroy() {
    if (this.unsubscribeTransactions) {
      this.unsubscribeTransactions();
      this.unsubscribeTransactions = null;
    }
  }

  private async handleTransaction(transaction: ITransaction) {
    const hash = transaction?.hash?.toString?.() || '';
    if (!hash) {
      return;
    }
    const pending = this.isPendingTransaction(transaction);
    const existingState = this.recentTxHashes.get(hash);
    if (existingState?.seenConfirmed) {
      return;
    }
    if (pending && existingState?.seenPending) {
      return;
    }
    this.rememberHash(hash, pending);

    const contractId = extractProfileMutationContractId(transaction);
    const functionName = extractProfileMutationFunction(transaction);
    const caller = extractProfileMutationCaller(transaction);
    const microTime = this.extractMicroTime(transaction);

    if (
      !contractId ||
      contractId !== this.profileContractService.getContractAddress() ||
      !this.profileMutationFunctions.has(functionName)
    ) {
      return;
    }

    if (
      functionName === 'set_x_name_with_attestation' &&
      isSuccessfulProfileMutation(transaction)
    ) {
      const xUsername = extractProfileMutationXUsername(transaction);
      if (caller && xUsername) {
        void this.profileXVerificationRewardService
          .sendRewardIfEligible(caller, xUsername)
          .catch(() => undefined);
      }
    }

    const affectedAddresses = new Set<string>();
    if (caller) {
      affectedAddresses.add(caller);
    }
    const autoRenamed = await this.extractAutoRenamedAddresses(
      transaction,
      functionName,
    );
    for (const address of autoRenamed) {
      affectedAddresses.add(address);
    }

    for (const address of affectedAddresses) {
      await this.profileIndexerService.refreshAddress(address, microTime);
    }
  }

  private rememberHash(hash: string, pending: boolean) {
    const previous = this.recentTxHashes.get(hash) || {
      seenPending: false,
      seenConfirmed: false,
    };
    this.recentTxHashes.set(hash, {
      seenPending: previous.seenPending || pending,
      seenConfirmed: previous.seenConfirmed || !pending,
    });
    this.recentTxHashQueue.push(hash);
    if (this.recentTxHashQueue.length > this.maxRecentTxHashes) {
      const oldest = this.recentTxHashQueue.shift();
      if (oldest) {
        this.recentTxHashes.delete(oldest);
      }
    }
  }

  private extractMicroTime(transaction: ITransaction): string | undefined {
    const value =
      transaction?.microTime ??
      (transaction as any)?.micro_time ??
      (transaction as any)?.tx?.micro_time ??
      null;
    if (value === null || value === undefined) {
      return undefined;
    }
    return value.toString();
  }

  private extractRawLog(transaction: ITransaction): any[] {
    return extractProfileMutationRawLog(transaction as any);
  }

  private isPendingTransaction(transaction: ITransaction): boolean {
    if (isPendingProfileMutation(transaction as any)) {
      return true;
    }
    const payload = extractProfileMutationPayload(transaction as any);
    return payload?.pending === true;
  }

  private async extractAutoRenamedAddresses(
    transaction: ITransaction,
    functionName: string,
  ): Promise<string[]> {
    if (!this.autoRenamePossibleFunctions.has(functionName)) {
      return [];
    }
    const rawLog = this.extractRawLog(transaction);
    if (rawLog.length === 0) {
      return [];
    }
    const decodedEvents =
      await this.profileContractService.decodeEvents(rawLog);
    const addresses: string[] = [];
    for (const event of decodedEvents) {
      if (event?.name !== 'CustomNameAutoRenamed') {
        continue;
      }
      const loser = event?.args?.[0];
      const loserAddress = loser?.toString?.() || '';
      if (loserAddress.startsWith('ak_')) {
        addresses.push(loserAddress);
      }
    }
    return addresses;
  }
}
