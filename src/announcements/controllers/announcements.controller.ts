import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';
import { AnnouncementService } from '../services/announcement.service';
import { ListAnnouncementsDto } from '../dto/list-announcements.dto';
import { AnnouncementView } from '../dto/announcement.view.dto';

@ApiTags('announcements')
@Controller('announcements')
@UseGuards(RateLimitGuard)
export class AnnouncementsController {
  constructor(private readonly service: AnnouncementService) {}

  /**
   * Public feed: only broadcast (target_type='all'), feed-visible announcements
   * that have been dispatched. The previous `?address=` filter was removed
   * because it let any caller enumerate which addresses had received specific
   * (DM-style) announcements; the admin reads `announcement_targets` directly
   * via Drizzle if it needs that view.
   */
  @Get()
  @ApiOkResponse({ type: [AnnouncementView] })
  async list(
    @Query() query: ListAnnouncementsDto,
  ): Promise<AnnouncementView[]> {
    const rows = await this.service.listPublic(
      query.page ?? 1,
      query.limit ?? 20,
    );
    return rows.map((a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      published_at: a.processed_at as Date,
    }));
  }
}
