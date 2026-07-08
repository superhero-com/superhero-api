import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import { PostReadsDaily } from '../entities/post-reads.entity';
import type { Request } from 'express';
import { POPULAR_RANKING_CONFIG } from '@/configs/constants';
import { REDIS_CONFIG } from '@/configs/redis';

@Injectable()
export class ReadsService implements OnModuleDestroy {
  private readonly logger = new Logger(ReadsService.name);
  private readonly redis = new Redis(REDIS_CONFIG);
  // Keys embed the UTC date, so a fixed TTL just past a full day is enough.
  private static readonly DEDUP_TTL_SECONDS = 25 * 60 * 60;

  constructor(
    @InjectRepository(PostReadsDaily)
    private readonly postReadsRepository: Repository<PostReadsDaily>,
  ) {
    this.redis.on('error', (error) => {
      this.logger.error('Reads dedup Redis connection error', error);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  async recordRead(postId: string, req: Request): Promise<void> {
    try {
      const ua = (req?.headers?.['user-agent'] as string) || '';
      if (this.isBotUserAgent(ua)) return;

      const today = new Date();
      const yyyy = today.getUTCFullYear();
      const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(today.getUTCDate()).padStart(2, '0');
      const dateOnly = `${yyyy}-${mm}-${dd}`;

      const isFirstReadToday = await this.isFirstReadToday(
        postId,
        dateOnly,
        req,
        ua,
      );
      if (!isFirstReadToday) return;

      // upsert reads += 1 for (post_id, date) using raw SQL for increment
      await this.postReadsRepository.query(
        `INSERT INTO post_reads_daily (post_id, date, reads)
         VALUES ($1, $2, 1)
         ON CONFLICT (post_id, date)
         DO UPDATE SET reads = post_reads_daily.reads + 1`,
        [postId, dateOnly],
      );
    } catch (e) {
      this.logger.debug('recordRead skipped', e as any);
    }
  }

  /**
   * One counted read per viewer, post, and UTC day. Viewer identity is an
   * IP+UA hash — coarse, but it stops a single client from inflating reads
   * with a request loop. Fails open (counts the read) when the viewer cannot
   * be identified or Redis is unavailable.
   */
  private async isFirstReadToday(
    postId: string,
    dateOnly: string,
    req: Request,
    ua: string,
  ): Promise<boolean> {
    const forwarded = (req?.headers?.['x-forwarded-for'] as string) || '';
    const ip =
      forwarded.split(',')[0]?.trim() ||
      req?.ip ||
      req?.socket?.remoteAddress ||
      '';
    if (!ip) return true;

    const viewer = createHash('sha256')
      .update(`${ip}:${ua}`)
      .digest('hex')
      .slice(0, 16);
    const key = `reads:seen:${dateOnly}:${postId}:${viewer}`;

    try {
      const created = await this.redis.set(
        key,
        '1',
        'EX',
        ReadsService.DEDUP_TTL_SECONDS,
        'NX',
      );
      return created !== null;
    } catch {
      return true;
    }
  }

  private isBotUserAgent(ua: string): boolean {
    if (!ua) return true;
    const deny = POPULAR_RANKING_CONFIG.BOT_UA_DENYLIST || [];
    const u = ua.toLowerCase();
    return deny.some((sig) => u.includes(sig));
  }
}
