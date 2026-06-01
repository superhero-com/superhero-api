import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { encode, Encoding } from '@aeternity/aepp-sdk';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Account } from '@/account/entities/account.entity';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { ProfileCacheService } from '@/profile/services/profile-cache.service';
import { ProfileXPostingRewardService } from '@/profile/services/profile-x-posting-reward.service';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection } from '../plugin.interface';
import { ACTIVE_NETWORK } from '@/configs/network';
import { ADDRESS_LINK_CONTRACT_ADDRESS } from './address-links.constants';

const LINK_EVENT_HASH =
  '6SB35NM6QMV5IG8BGTLL5O77IU72C5E3OC63PB4KHNDNSS83HAOG====';
const UNLINK_EVENT_HASH =
  'EIE1QPIL7TJBARSE513J05U144N3D9Q0MB4PQ69VATC40VROO3IG====';

const LINK_EVENT_NAMES = new Set(['Link', 'PrincipalLink']);
const UNLINK_EVENT_NAMES = new Set(['Unlink', 'PrincipalUnlink']);

@Injectable()
export class AddressLinksPluginSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(AddressLinksPluginSyncService.name);

  constructor(
    aeSdkService: AeSdkService,
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
    private readonly profileXPostingRewardService: ProfileXPostingRewardService,
    private readonly profileCacheService: ProfileCacheService,
  ) {
    super(aeSdkService);
  }

  async processTransaction(
    tx: Tx,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _syncDirection: SyncDirection,
  ): Promise<void> {
    if (tx.function === 'link_principal') {
      await this.syncLinkPrincipalFromTx(tx);
      return;
    }
    if (tx.function === 'unlink_principal') {
      await this.syncUnlinkPrincipalFromTx(tx);
      return;
    }
    await this.fetchAndProcessLogs(tx);
  }

  private async fetchAndProcessLogs(tx: Tx) {
    const middlewareUrl = ACTIVE_NETWORK.middlewareUrl;
    const url = `${middlewareUrl}/v3/contracts/logs?contract_id=${ADDRESS_LINK_CONTRACT_ADDRESS}&tx_hash=${tx.hash}&limit=100`;

    const response = await fetch(url);
    if (!response.ok) {
      this.logger.warn(
        `Failed to fetch contract logs for tx ${tx.hash}: ${response.status}`,
      );
      return;
    }

    const data = await response.json();
    const logs: any[] = data.data ?? [];

    for (const log of logs) {
      await this.processLog(tx, log);
    }
  }

  private async processLog(tx: Tx, log: any) {
    const eventHash: string | undefined = log.event_hash;
    if (!eventHash) return;

    const addressInt: string | undefined = log.args?.[0];
    const payload: string | undefined = log.data;

    if (!addressInt || !payload) return;

    const address = this.intToAddress(addressInt);
    if (!address) return;

    const eventName: string | undefined = log.event_name;

    if (
      eventHash === LINK_EVENT_HASH ||
      (eventName && LINK_EVENT_NAMES.has(eventName))
    ) {
      await this.handleLinkEvent(tx, address, payload);
    } else if (
      eventHash === UNLINK_EVENT_HASH ||
      (eventName && UNLINK_EVENT_NAMES.has(eventName))
    ) {
      await this.handleUnlinkEvent(tx, address, payload);
    }
  }

  private getRawArgument(tx: Tx, name: string): string | undefined {
    const args = tx.raw?.arguments;
    if (!Array.isArray(args)) {
      return undefined;
    }
    const entry = args.find(
      (arg: { name?: string; value?: unknown }) => arg?.name === name,
    );
    if (entry?.value === undefined || entry?.value === null) {
      return undefined;
    }
    return String(entry.value);
  }

  private async syncLinkPrincipalFromTx(tx: Tx): Promise<void> {
    const signer = this.getRawArgument(tx, 'signer');
    const provider = this.getRawArgument(tx, 'provider');
    const value = this.getRawArgument(tx, 'value');

    if (!signer || !provider || !value) {
      this.logger.warn(
        `link_principal tx ${tx.hash} missing signer, provider, or value in raw arguments`,
      );
      await this.fetchAndProcessLogs(tx);
      return;
    }

    await this.handleLinkEvent(tx, signer, `${provider}:${value}`);
  }

  private async syncUnlinkPrincipalFromTx(tx: Tx): Promise<void> {
    const signer = this.getRawArgument(tx, 'signer');
    const provider = this.getRawArgument(tx, 'provider');

    if (!signer || !provider) {
      this.logger.warn(
        `unlink_principal tx ${tx.hash} missing signer or provider in raw arguments`,
      );
      await this.fetchAndProcessLogs(tx);
      return;
    }

    await this.handleUnlinkEvent(tx, signer, `${provider}:`);
  }

  private intToAddress(intStr: string): string | null {
    try {
      const hex = BigInt(intStr).toString(16).padStart(64, '0');
      return encode(Buffer.from(hex, 'hex'), Encoding.AccountAddress);
    } catch {
      this.logger.warn(`Failed to decode address integer: ${intStr}`);
      return null;
    }
  }

  private async ensureAccount(address: string): Promise<void> {
    const exists = await this.accountRepo.findOne({
      where: { address },
      select: ['address'],
    });
    if (!exists) {
      this.logger.log(`Creating account row for ${address}`);
      await this.accountRepo
        .createQueryBuilder()
        .insert()
        .into(Account)
        .values({ address })
        .orIgnore()
        .execute();
    }
  }

  private isValidProvider(provider: string): boolean {
    return /^[a-z]{1,10}$/.test(provider);
  }

  private async handleLinkEvent(tx: Tx, address: string, payload: string) {
    const colonIdx = payload.indexOf(':');
    if (colonIdx === -1) return;

    const provider = payload.substring(0, colonIdx);
    const value = payload.substring(colonIdx + 1);

    if (!this.isValidProvider(provider)) {
      this.logger.warn(
        `Ignoring link event with invalid provider: ${provider}`,
      );
      return;
    }

    this.logger.log(`Link: ${address} -> ${provider}:${value}`);

    await this.ensureAccount(address);

    await this.accountRepo
      .createQueryBuilder()
      .update(Account)
      .set({
        links: () =>
          `jsonb_set(COALESCE(links, '{}'), ARRAY[:provider]::text[], to_jsonb(:value::text))`,
      })
      .setParameter('provider', provider)
      .setParameter('value', value)
      .where('address = :address', { address })
      .execute();

    // Keep the profile_cache mirror fresh so the profile feed re-orders and
    // link-only accounts become visible (the old ProfileRegistry indexer that
    // used to write this table was removed with the AddressLink migration).
    await this.profileCacheService.syncFromAccountLinks(
      address,
      tx.micro_time?.toString?.(),
    );

    if (provider === 'x') {
      // TODO(reward-program): The X posting reward is disabled right now (see
      // PROFILE_REWARDS_DISABLED / PROFILE_X_POSTING_REWARD_ENABLED), so this
      // call is a no-op and pays nothing. The only sponsored operations are
      // name claims and profile adjustments. Re-enable once the reward program
      // is decided.
      await this.profileXPostingRewardService.upsertVerifiedCandidateFromTx(
        address,
        value,
        tx.micro_time?.toString?.(),
        tx.hash,
      );
    }
  }

  private async handleUnlinkEvent(tx: Tx, address: string, payload: string) {
    const colonIdx = payload.indexOf(':');
    if (colonIdx === -1) return;

    const provider = payload.substring(0, colonIdx);

    if (!this.isValidProvider(provider)) {
      this.logger.warn(
        `Ignoring unlink event with invalid provider: ${provider}`,
      );
      return;
    }

    this.logger.log(`Unlink: ${address} -> ${provider}`);

    await this.ensureAccount(address);

    await this.accountRepo
      .createQueryBuilder()
      .update(Account)
      .set({
        links: () => `links - :provider`,
      })
      .setParameter('provider', provider)
      .where('address = :address', { address })
      .execute();

    // Mirror the change into profile_cache (bumps updated_at) so the feed and
    // accounts search reflect the unlink.
    await this.profileCacheService.syncFromAccountLinks(
      address,
      tx.micro_time?.toString?.(),
    );
  }
}
