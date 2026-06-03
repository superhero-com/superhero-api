import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationPreference } from '../entities/notification-preference.entity';
import {
  NOTIFICATION_CATALOG,
  NOTIFICATION_CATALOG_BY_TYPE,
} from '../notification-catalog';
import { PreferenceView } from '../dto/preference.view.dto';

/**
 * Reads + writes per-(address, type) opt-out flags. The default for a missing row
 * is **enabled = true** (opt-out model), so existing users keep receiving the
 * notifications they were getting before this feature shipped.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    @InjectRepository(NotificationPreference)
    private readonly repo: Repository<NotificationPreference>,
  ) {}

  /** Single-key lookup used at the dispatch chokepoint. */
  async isEnabled(address: string, type: string): Promise<boolean> {
    const row = await this.repo.findOne({ where: { address, type } });
    return row ? row.enabled : true;
  }

  /** Catalog ⨝ stored overrides; missing rows default to enabled. */
  async listFor(address: string): Promise<PreferenceView[]> {
    const rows = await this.repo.find({ where: { address } });
    const byType = new Map(rows.map((r) => [r.type, r]));
    return NOTIFICATION_CATALOG.map((meta) => ({
      id: meta.type,
      title: meta.title,
      short_description: meta.description,
      enabled: byType.has(meta.type) ? byType.get(meta.type)!.enabled : true,
    }));
  }

  /** Partial upsert: rejects unknown types; untouched types keep their state. */
  async applyPartial(
    address: string,
    items: { type: string; enabled: boolean }[],
  ): Promise<void> {
    if (items.length === 0) return;
    const unknown = items.filter(
      (it) => !NOTIFICATION_CATALOG_BY_TYPE.has(it.type),
    );
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown notification types: ${unknown.map((u) => u.type).join(', ')}`,
      );
    }
    await this.repo.upsert(
      items.map((it) => ({
        address,
        type: it.type,
        enabled: it.enabled,
      })),
      { conflictPaths: ['address', 'type'] },
    );
  }
}
