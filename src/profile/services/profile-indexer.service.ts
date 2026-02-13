import { ACTIVE_NETWORK } from '@/configs';
import { fetchJson } from '@/utils/common';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProfileCache } from '../entities/profile-cache.entity';
import { ProfileSyncState } from '../entities/profile-sync-state.entity';
import { ProfileContractService } from './profile-contract.service';

@Injectable()
export class ProfileIndexerService {
  private readonly logger = new Logger(ProfileIndexerService.name);
  private readonly stateId = 'global';
  private isRunning = false;

  constructor(
    @InjectRepository(ProfileCache)
    private readonly profileCacheRepository: Repository<ProfileCache>,
    @InjectRepository(ProfileSyncState)
    private readonly profileSyncStateRepository: Repository<ProfileSyncState>,
    private readonly profileContractService: ProfileContractService,
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

          const fn = (tx?.function || '').toString();
          if (
            fn === 'set_profile' ||
            fn === 'set_custom_name' ||
            fn === 'clear_custom_name' ||
            fn === 'set_chain_name' ||
            fn === 'clear_chain_name' ||
            fn === 'set_x_name_with_attestation' ||
            fn === 'clear_x_name' ||
            fn === 'set_display_source'
          ) {
            const caller = tx?.caller_id?.toString?.();
            if (caller) {
              changedAddresses.add(caller);
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

    await this.profileCacheRepository.save({
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
    });
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
}
