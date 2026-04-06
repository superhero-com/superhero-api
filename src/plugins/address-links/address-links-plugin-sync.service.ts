import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { encode, Encoding } from '@aeternity/aepp-sdk';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Account } from '@/account/entities/account.entity';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection } from '../plugin.interface';
import { ACTIVE_NETWORK } from '@/configs/network';
import { ADDRESS_LINK_CONTRACT_ADDRESS } from './address-links.constants';

const LINK_EVENT_HASH =
  '6SB35NM6QMV5IG8BGTLL5O77IU72C5E3OC63PB4KHNDNSS83HAOG====';
const UNLINK_EVENT_HASH =
  'EIE1QPIL7TJBARSE513J05U144N3D9Q0MB4PQ69VATC40VROO3IG====';

@Injectable()
export class AddressLinksPluginSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(AddressLinksPluginSyncService.name);

  constructor(
    aeSdkService: AeSdkService,
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
  ) {
    super(aeSdkService);
  }

  async processTransaction(
    tx: Tx,
    _syncDirection: SyncDirection,
  ): Promise<void> {
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
      await this.processLog(log);
    }
  }

  private async processLog(log: any) {
    const eventHash: string | undefined = log.event_hash;
    if (!eventHash) return;

    const addressInt: string | undefined = log.args?.[0];
    const payload: string | undefined = log.data;

    if (!addressInt || !payload) return;

    const address = this.intToAddress(addressInt);
    if (!address) return;

    if (eventHash === LINK_EVENT_HASH) {
      await this.handleLinkEvent(address, payload);
    } else if (eventHash === UNLINK_EVENT_HASH) {
      await this.handleUnlinkEvent(address, payload);
    }
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

  private async handleLinkEvent(address: string, payload: string) {
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
  }

  private async handleUnlinkEvent(address: string, payload: string) {
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
  }
}
