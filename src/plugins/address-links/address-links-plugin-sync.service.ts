import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { encode, Encoding } from '@aeternity/aepp-sdk';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Account } from '@/account/entities/account.entity';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { ProfileCacheService } from '@/profile/services/profile-cache.service';
import { ProfileXPostingRewardService } from '@/profile/services/profile-x-posting-reward.service';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection } from '../plugin.interface';
import { ACTIVE_NETWORK } from '@/configs/network';
import { ADDRESS_LINK_CONTRACT_ADDRESS } from './address-links.constants';
import {
  TGR_LINK_CHANGED,
  TgrLinkChangedPayload,
} from '@/token-gated-rooms/events';

/**
 * Token-gated-rooms link provider (default `nostr`, env-overridable). Token-gated
 * rooms only care about the nostr link, so the `tgr.link.changed` seam below
 * fires only for this provider to avoid waking the identity pipeline on unrelated
 * link/unlink (x/site/bio/…). Kept in lockstep with `tgrConfig.nostrLinkProvider`
 * via the same `NOSTR_LINK_PROVIDER` env var. */
const NOSTR_LINK_PROVIDER = process.env.NOSTR_LINK_PROVIDER || 'nostr';

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
    // Optional so the existing unit DI (which builds a minimal testing module)
    // still resolves; the global EventEmitterModule provides it in the real app.
    // This is the Task 05 seam: emit `tgr.link.changed` on nostr link/unlink so
    // the identity-resolution pipeline (IdentityService) re-resolves member_pubkey
    // and the eligibility service (Task 06) re-evaluates. Reactive correctness for
    // existing links is covered by IdentityBackfillService at startup.
    @Optional()
    private readonly eventEmitter?: EventEmitter2,
  ) {
    super(aeSdkService);
  }

  /**
   * Notify the token-gated-rooms identity pipeline that an account's nostr link
   * changed. Fires only for the nostr provider (token-gated rooms ignore other
   * providers) and is a no-op when no EventEmitter is wired (e.g. minimal tests).
   */
  private emitTgrLinkChanged(provider: string, address: string): void {
    if (provider !== NOSTR_LINK_PROVIDER) return;
    if (!this.eventEmitter) return;
    const payload: TgrLinkChangedPayload = { address };
    this.eventEmitter.emit(TGR_LINK_CHANGED, payload);
  }

  async processTransaction(
    tx: Tx,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _syncDirection: SyncDirection,
  ): Promise<void> {
    if (tx.function === 'link') {
      await this.syncLinkFromTx(tx);
      return;
    }
    if (tx.function === 'unlink') {
      await this.syncUnlinkFromTx(tx);
      return;
    }
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

  /**
   * Read a decoded contract-call argument out of `tx.raw.arguments`.
   *
   * The middleware returns contract-call arguments as an ordered
   * `[{ type, value }]` list with NO `name` field, so they must be resolved
   * positionally (matching the function signature in the contract ACI). A
   * name match is kept only as a defensive fallback in case a future
   * middleware version starts including argument names.
   */
  private getRawArgument(
    tx: Tx,
    index: number,
    name: string,
  ): string | undefined {
    const args = tx.raw?.arguments;
    if (!Array.isArray(args)) {
      return undefined;
    }
    const byName = args.find(
      (arg: { name?: string; value?: unknown }) => arg?.name === name,
    );
    const entry = byName ?? args[index];
    if (entry?.value === undefined || entry?.value === null) {
      return undefined;
    }
    return String(entry.value);
  }

  private async syncLinkFromTx(tx: Tx): Promise<void> {
    // link(addr, provider, value, nonce, sig)
    //
    // Decode the call arguments directly instead of round-tripping to the
    // middleware contract-logs endpoint. During live (websocket) sync the tx is
    // delivered the moment it is mined, but the middleware has not necessarily
    // indexed its *logs* yet, so /v3/contracts/logs returns an empty list and
    // the link silently fails to apply until a later catch-up pass reprocesses
    // the block. Reading the args makes the update instant and deterministic.
    const addr = this.getRawArgument(tx, 0, 'addr');
    const provider = this.getRawArgument(tx, 1, 'provider');
    const value = this.getRawArgument(tx, 2, 'value');

    if (!addr || !provider || value === undefined) {
      this.logger.warn(
        `link tx ${tx.hash} missing addr, provider, or value in raw arguments`,
      );
      await this.fetchAndProcessLogs(tx);
      return;
    }

    await this.handleLinkEvent(tx, addr, `${provider}:${value}`);
  }

  private async syncUnlinkFromTx(tx: Tx): Promise<void> {
    // unlink(addr, provider, nonce, sig)
    const addr = this.getRawArgument(tx, 0, 'addr');
    const provider = this.getRawArgument(tx, 1, 'provider');

    if (!addr || !provider) {
      this.logger.warn(
        `unlink tx ${tx.hash} missing addr or provider in raw arguments`,
      );
      await this.fetchAndProcessLogs(tx);
      return;
    }

    await this.handleUnlinkEvent(tx, addr, `${provider}:`);
  }

  private async syncLinkPrincipalFromTx(tx: Tx): Promise<void> {
    // link_principal(principal, signer, provider, value, nonce, sig)
    const signer = this.getRawArgument(tx, 1, 'signer');
    const provider = this.getRawArgument(tx, 2, 'provider');
    const value = this.getRawArgument(tx, 3, 'value');

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
    // unlink_principal(principal, signer, provider, nonce, sig)
    const signer = this.getRawArgument(tx, 1, 'signer');
    const provider = this.getRawArgument(tx, 2, 'provider');

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

    // Task 05 seam: tell the identity pipeline this nostr link changed.
    this.emitTgrLinkChanged(provider, address);

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

    // Task 05 seam: tell the identity pipeline this nostr link was removed.
    this.emitTgrLinkChanged(provider, address);
  }
}
