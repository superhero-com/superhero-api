import { ACTIVE_NETWORK } from '@/configs';
import { Account } from '@/account/entities/account.entity';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ADDRESS_LINK_CONTRACT_ADDRESS } from './address-links.constants';

@Injectable()
export class AddressLinksEventListenerService implements OnModuleInit {
  private readonly logger = new Logger(AddressLinksEventListenerService.name);
  private isRunning = false;
  private lastCursor: string | null = null;

  constructor(
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
  ) {}

  onModuleInit() {
    if (!ADDRESS_LINK_CONTRACT_ADDRESS) {
      this.logger.warn(
        'AddressLink event listener disabled: ADDRESS_LINK_CONTRACT_ADDRESS not set',
      );
      return;
    }
    this.logger.log(
      `AddressLink event listener initialized for ${ADDRESS_LINK_CONTRACT_ADDRESS}`,
    );
  }

  @Cron('*/10 * * * * *')
  async pollEvents() {
    if (this.isRunning || !ADDRESS_LINK_CONTRACT_ADDRESS) {
      return;
    }

    this.isRunning = true;
    try {
      await this.fetchAndProcessEvents();
    } catch (error) {
      this.logger.error('AddressLink event polling failed', error);
    } finally {
      this.isRunning = false;
    }
  }

  private async fetchAndProcessEvents() {
    const middlewareUrl = ACTIVE_NETWORK.middlewareUrl;
    let url = `${middlewareUrl}/v3/contracts/logs?contract_id=${ADDRESS_LINK_CONTRACT_ADDRESS}&direction=forward&limit=100`;

    if (this.lastCursor) {
      url += `&cursor=${this.lastCursor}`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      return;
    }

    const data = await response.json();
    const logs: any[] = data.data ?? [];

    for (const log of logs) {
      await this.processLog(log);
    }

    if (data.next) {
      this.lastCursor = this.extractCursor(data.next);
    }
  }

  private async processLog(log: any) {
    const eventName = log.event_name;
    const address: string | undefined = log.args?.[0];
    const payload: string | undefined = log.args?.[1];

    if (!address || !payload) {
      return;
    }

    if (eventName === 'Link') {
      await this.handleLinkEvent(address, payload);
    } else if (eventName === 'Unlink') {
      await this.handleUnlinkEvent(address, payload);
    }
  }

  private async handleLinkEvent(address: string, payload: string) {
    const colonIdx = payload.indexOf(':');
    if (colonIdx === -1) {
      return;
    }

    const provider = payload.substring(0, colonIdx);
    const value = payload.substring(colonIdx + 1);

    this.logger.log(`Link: ${address} -> ${provider}:${value}`);

    await this.accountRepo
      .createQueryBuilder()
      .update(Account)
      .set({
        links: () =>
          `jsonb_set(COALESCE(links, '{}'), '{${provider}}', '"${value}"')`,
      })
      .where('address = :address', { address })
      .execute();
  }

  private async handleUnlinkEvent(address: string, payload: string) {
    const colonIdx = payload.indexOf(':');
    if (colonIdx === -1) {
      return;
    }

    const provider = payload.substring(0, colonIdx);

    this.logger.log(`Unlink: ${address} -> ${provider}`);

    await this.accountRepo
      .createQueryBuilder()
      .update(Account)
      .set({
        links: () => `links - '${provider}'`,
      })
      .where('address = :address', { address })
      .execute();
  }

  private extractCursor(nextUrl: string): string {
    try {
      const url = new URL(nextUrl, 'http://placeholder');
      return url.searchParams.get('cursor') || nextUrl;
    } catch {
      return nextUrl;
    }
  }
}
