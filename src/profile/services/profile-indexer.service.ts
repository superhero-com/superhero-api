import { ACTIVE_NETWORK } from '@/configs';
import { fetchJson } from '@/utils/common';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProfileCache } from '../entities/profile-cache.entity';
import { PROFILE_MUTATION_FUNCTIONS } from '../profile.constants';
import { ProfileSyncState } from '../entities/profile-sync-state.entity';
import { ProfileContractService } from './profile-contract.service';
import { ProfileXVerificationRewardService } from './profile-x-verification-reward.service';

@Injectable()
export class ProfileIndexerService {
  private readonly logger = new Logger(ProfileIndexerService.name);
  private readonly stateId = 'global';
  private isRunning = false;
  private readonly profileMutationFunctions = new Set<string>(
    PROFILE_MUTATION_FUNCTIONS,
  );
  private readonly autoRenamePossibleFunctions = new Set<string>([
    'set_chain_name',
    'set_x_name_with_attestation',
    'set_profile_full',
  ]);

  constructor(
    @InjectRepository(ProfileCache)
    private readonly profileCacheRepository: Repository<ProfileCache>,
    @InjectRepository(ProfileSyncState)
    private readonly profileSyncStateRepository: Repository<ProfileSyncState>,
    private readonly profileContractService: ProfileContractService,
    private readonly profileXVerificationRewardService: ProfileXVerificationRewardService,
  ) {}

  @Cron('*/30 * * * * *')
  async syncProfileChanges() {
    if (this.isRunning || !this.profileContractService.isConfigured()) {
      return;
    }

    this.isRunning = true;
    try {
      const state = await this.getOrCreateState();
      const middlewareUrl = ACTIVE_NETWORK.middlewareUrl;
      const contract = this.profileContractService.getContractAddress();
      const lastIndexedMicroTime = BigInt(state.last_indexed_micro_time || '0');
      let endpoint = `${middlewareUrl}/v3/transactions?type=contract_call&contract=${contract}&direction=backward&limit=100`;
      let nextStateMicroTime = lastIndexedMicroTime;
      const changedAddresses = new Set<string>();
      let reachedIndexedBoundary = false;
      let pageSafetyCounter = 0;

      while (endpoint && !reachedIndexedBoundary && pageSafetyCounter < 200) {
        pageSafetyCounter += 1;
        const response = await fetchJson<any>(endpoint);
        const txs = response?.data || [];

        for (const tx of txs) {
          const microTime = BigInt(tx?.micro_time || '0');
          if (microTime <= lastIndexedMicroTime) {
            reachedIndexedBoundary = true;
            break;
          }

          const fn = this.extractTxFunction(tx);
          if (this.profileMutationFunctions.has(fn)) {
            if (
              fn === 'set_x_name_with_attestation' &&
              this.isSuccessfulMutation(tx)
            ) {
              const caller = this.extractTxSigner(tx);
              const xUsername = this.extractXUsername(tx);
              if (caller && xUsername) {
                void this.profileXVerificationRewardService
                  .sendRewardIfEligible(caller, xUsername)
                  .catch(() => undefined);
              }
            }
            const affected = await this.extractAffectedAddresses(tx, fn);
            for (const address of affected) {
              changedAddresses.add(address);
            }
          }

          if (microTime > nextStateMicroTime) {
            nextStateMicroTime = microTime;
          }
        }

        if (!response?.next || reachedIndexedBoundary) {
          break;
        }

        endpoint = response.next.startsWith('http')
          ? response.next
          : `${middlewareUrl}${response.next}`;
      }

      for (const address of changedAddresses) {
        await this.refreshAddress(address, nextStateMicroTime.toString());
      }

      if (nextStateMicroTime > lastIndexedMicroTime) {
        await this.profileSyncStateRepository.update(
          { id: this.stateId },
          { last_indexed_micro_time: nextStateMicroTime.toString() },
        );
      }
    } catch (error) {
      this.logger.error('Profile indexer sync failed', error);
    } finally {
      this.isRunning = false;
    }
  }

  async refreshAddress(address: string, microTime?: string) {
    const profile = await this.profileContractService.getProfile(address);
    if (!profile) {
      return;
    }

    const publicName = this.selectPublicName(
      profile.display_source || 'custom',
      profile.username || null,
      profile.chain_name || null,
      profile.x_username || null,
    );

    await this.profileCacheRepository.upsert(
      {
        address,
        fullname: profile.fullname || '',
        bio: profile.bio || '',
        avatarurl: profile.avatarurl || '',
        username: profile.username || null,
        x_username: profile.x_username || null,
        chain_name: profile.chain_name || null,
        display_source: profile.display_source || 'custom',
        chain_expires_at: profile.chain_expires_at || null,
        public_name: publicName,
        last_seen_micro_time: microTime || null,
      },
      { conflictPaths: ['address'] },
    );
  }

  private selectPublicName(
    displaySource: string,
    username: string | null,
    chainName: string | null,
    xName: string | null,
  ): string | null {
    const source = (displaySource || '').toLowerCase();
    if (source === 'custom' && username) {
      return username;
    }
    if (source === 'chain' && chainName) {
      return chainName;
    }
    if (source === 'x' && xName) {
      return xName;
    }
    return username || chainName || xName || null;
  }

  private async getOrCreateState(): Promise<ProfileSyncState> {
    let state = await this.profileSyncStateRepository.findOne({
      where: { id: this.stateId },
    });

    if (!state) {
      state = await this.profileSyncStateRepository.save({
        id: this.stateId,
        last_indexed_micro_time: '0',
      });
    }

    return state;
  }

  private async extractAffectedAddresses(
    tx: any,
    functionName: string,
  ): Promise<Set<string>> {
    const addresses = new Set<string>();
    const caller = this.extractTxSigner(tx);
    if (caller) {
      addresses.add(caller);
    }

    if (!this.autoRenamePossibleFunctions.has(functionName)) {
      return addresses;
    }

    const rawLog = this.extractRawLog(tx);
    if (rawLog.length === 0) {
      return addresses;
    }

    const decodedEvents =
      await this.profileContractService.decodeEvents(rawLog);
    for (const event of decodedEvents) {
      if (event?.name !== 'CustomNameAutoRenamed') {
        continue;
      }
      const loserAddress = event?.args?.[0]?.toString?.() || '';
      if (loserAddress.startsWith('ak_')) {
        addresses.add(loserAddress);
      }
    }

    return addresses;
  }

  private extractRawLog(tx: any): any[] {
    const payload = this.extractMutationPayload(tx);
    const rawLog =
      payload?.log ||
      tx?.tx?.log ||
      tx?.tx?.tx?.log ||
      tx?.tx?.tx?.tx?.log ||
      tx?.log ||
      tx?.raw?.log ||
      [];
    return Array.isArray(rawLog) ? rawLog : [];
  }

  private extractTxSigner(tx: any): string | null {
    const payload = this.extractMutationPayload(tx);
    return (
      payload?.caller_id?.toString?.() ||
      payload?.callerId?.toString?.() ||
      tx?.caller_id?.toString?.() ||
      tx?.callerId?.toString?.() ||
      null
    );
  }

  private extractTxFunction(tx: any): string {
    const payload = this.extractMutationPayload(tx);
    return (
      payload?.function?.toString?.() ||
      tx?.function?.toString?.() ||
      ''
    );
  }

  private isSuccessfulMutation(tx: any): boolean {
    const payload = this.extractMutationPayload(tx);
    if (tx?.pending === true || tx?.tx?.pending === true) {
      return false;
    }
    const returnType = (
      payload?.return_type?.toString?.() ||
      payload?.returnType?.toString?.() ||
      tx?.tx?.return_type?.toString?.() ||
      tx?.tx?.returnType?.toString?.() ||
      tx?.return_type?.toString?.() ||
      tx?.returnType?.toString?.() ||
      ''
    )
      .toString()
      .toLowerCase();
    if (!returnType) {
      return false;
    }
    return returnType !== 'revert';
  }

  private extractXUsername(tx: any): string | null {
    const payload = this.extractMutationPayload(tx);
    const xUsername =
      payload?.arguments?.[0]?.value?.toString?.() ||
      tx?.arguments?.[0]?.value?.toString?.() ||
      null;
    if (!xUsername) {
      return null;
    }
    return xUsername.trim().toLowerCase().replace(/^@+/, '');
  }

  private extractMutationPayload(tx: any): any {
    const candidates = [tx?.tx?.tx?.tx, tx?.tx?.tx, tx?.tx, tx];
    const matched = candidates.find((candidate) => {
      const contractId = candidate?.contractId || candidate?.contract_id;
      const fn = candidate?.function;
      return !!contractId && !!fn;
    });
    return matched || tx;
  }
}
