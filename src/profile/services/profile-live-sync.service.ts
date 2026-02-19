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

@Injectable()
export class ProfileLiveSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProfileLiveSyncService.name);
  private unsubscribeTransactions: (() => void) | null = null;
  private readonly profileMutationFunctions = new Set<string>(
    PROFILE_MUTATION_FUNCTIONS,
  );
  private readonly recentTxHashes = new Set<string>();
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
    if (!hash || this.recentTxHashes.has(hash)) {
      return;
    }
    this.rememberHash(hash);

    const contractId = this.extractContractId(transaction);
    const functionName = this.extractFunctionName(transaction);
    const caller = this.extractCaller(transaction);
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
      this.isSuccessfulMutation(transaction)
    ) {
      const xUsername = this.extractXUsername(transaction);
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

  private rememberHash(hash: string) {
    this.recentTxHashes.add(hash);
    this.recentTxHashQueue.push(hash);
    if (this.recentTxHashQueue.length > this.maxRecentTxHashes) {
      const oldest = this.recentTxHashQueue.shift();
      if (oldest) {
        this.recentTxHashes.delete(oldest);
      }
    }
  }

  private extractContractId(transaction: ITransaction): string {
    return (
      transaction?.tx?.contractId?.toString?.() ||
      (transaction as any)?.tx?.contract_id?.toString?.() ||
      (transaction as any)?.tx?.tx?.contractId?.toString?.() ||
      (transaction as any)?.tx?.tx?.contract_id?.toString?.() ||
      (transaction as any)?.tx?.tx?.tx?.contractId?.toString?.() ||
      (transaction as any)?.tx?.tx?.tx?.contract_id?.toString?.() ||
      (transaction as any)?.contractId?.toString?.() ||
      (transaction as any)?.contract_id?.toString?.() ||
      ''
    );
  }

  private extractFunctionName(transaction: ITransaction): string {
    return (
      transaction?.tx?.function?.toString?.() ||
      (transaction as any)?.tx?.function?.toString?.() ||
      (transaction as any)?.tx?.tx?.function?.toString?.() ||
      (transaction as any)?.tx?.tx?.tx?.function?.toString?.() ||
      (transaction as any)?.function?.toString?.() ||
      ''
    );
  }

  private extractCaller(transaction: ITransaction): string | null {
    return (
      transaction?.tx?.callerId?.toString?.() ||
      (transaction as any)?.tx?.caller_id?.toString?.() ||
      (transaction as any)?.tx?.tx?.callerId?.toString?.() ||
      (transaction as any)?.tx?.tx?.caller_id?.toString?.() ||
      (transaction as any)?.tx?.tx?.tx?.callerId?.toString?.() ||
      (transaction as any)?.tx?.tx?.tx?.caller_id?.toString?.() ||
      (transaction as any)?.callerId?.toString?.() ||
      (transaction as any)?.caller_id?.toString?.() ||
      null
    );
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

  private isSuccessfulMutation(transaction: ITransaction): boolean {
    if (transaction?.pending === true) {
      return false;
    }
    const returnType = (
      (transaction as any)?.tx?.returnType ||
      (transaction as any)?.tx?.return_type ||
      (transaction as any)?.returnType ||
      (transaction as any)?.return_type ||
      ''
    )
      .toString()
      .toLowerCase();
    if (!returnType) {
      return false;
    }
    return returnType !== 'revert';
  }

  private extractXUsername(transaction: ITransaction): string | null {
    const username =
      (transaction as any)?.tx?.arguments?.[0]?.value?.toString?.() ||
      (transaction as any)?.tx?.tx?.arguments?.[0]?.value?.toString?.() ||
      (transaction as any)?.arguments?.[0]?.value?.toString?.() ||
      null;
    if (!username) {
      return null;
    }
    return username.trim().toLowerCase().replace(/^@+/, '');
  }

  private extractRawLog(transaction: ITransaction): any[] {
    const tx: any = transaction as any;
    const rawLog =
      tx?.tx?.log || tx?.tx?.tx?.log || tx?.tx?.tx?.tx?.log || tx?.log || tx?.raw?.log || [];
    return Array.isArray(rawLog) ? rawLog : [];
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
