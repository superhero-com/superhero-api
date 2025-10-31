import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PostReadsDaily } from '../entities/post-reads.entity';
import type { Request } from 'express';
import { POPULAR_RANKING_CONFIG } from '@/configs/constants';

@Injectable()
export class ReadsService {
  private readonly logger = new Logger(ReadsService.name);

  constructor(
    @InjectRepository(PostReadsDaily)
    private readonly postReadsRepository: Repository<PostReadsDaily>,
  ) {}

  async recordRead(postId: string, req: Request): Promise<void> {
    try {
      const ua = (req?.headers?.['user-agent'] as string) || '';
      if (this.isBotUserAgent(ua)) return;

      const today = new Date();
      const yyyy = today.getUTCFullYear();
      const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(today.getUTCDate()).padStart(2, '0');
      const dateOnly = `${yyyy}-${mm}-${dd}`;

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

  private isBotUserAgent(ua: string): boolean {
    if (!ua) return true;
    const deny = POPULAR_RANKING_CONFIG.BOT_UA_DENYLIST || [];
    const u = ua.toLowerCase();
    return deny.some((sig) => u.includes(sig));
  }
}
