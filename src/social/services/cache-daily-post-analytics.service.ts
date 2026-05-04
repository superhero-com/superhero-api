import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import moment from 'moment';
import { LessThan, Repository } from 'typeorm';
import { Post } from '../entities/post.entity';
import { PostAnalytic } from '../entities/post-analytic.entity';

export interface DatePostAnalyticsRow {
  date: string;
  total_posts: number;
  total_comments: number;
  total_all: number;
  total_unique_posters: number;
  cumulative_total_posts: number;
  avg_comments_per_post: number;
}

@Injectable()
export class CacheDailyPostAnalyticsService {
  private readonly logger = new Logger(CacheDailyPostAnalyticsService.name);

  constructor(
    @InjectRepository(PostAnalytic)
    private postAnalyticsRepository: Repository<PostAnalytic>,

    @InjectRepository(Post)
    private postsRepository: Repository<Post>,
  ) {
    //
  }

  onModuleInit() {
    setTimeout(() => this.pullDailyPostAnalyticsData(), 20_000);
  }

  isPullingDailyPostAnalyticsData = false;
  @Cron(CronExpression.EVERY_HOUR)
  async pullDailyPostAnalyticsData() {
    if (this.isPullingDailyPostAnalyticsData) {
      return;
    }
    this.isPullingDailyPostAnalyticsData = true;
    try {
      const latestAnalytic = await this.postAnalyticsRepository.findOne({
        where: {},
        order: {
          date: 'DESC',
        },
      });

      let startDate = latestAnalytic?.date;

      if (!startDate) {
        const firstPost = await this.postsRepository.findOne({
          where: {},
          order: {
            created_at: 'ASC',
          },
        });
        startDate = firstPost?.created_at;
      } else {
        // re-pull last 7 days to keep recent data fresh
        startDate = moment().subtract(7, 'day').toDate();
      }

      if (!startDate) {
        return;
      }

      const endDate = moment().add(1, 'day').toDate();

      await this.pullAnalyticsDataByDateRange(startDate, endDate);
    } catch (error: any) {
      this.logger.error(
        'Error pulling daily post analytics data',
        error,
        error?.stack,
      );
    } finally {
      this.isPullingDailyPostAnalyticsData = false;
    }
  }

  async pullAnalyticsDataByDateRange(startDate: Date, endDate: Date) {
    const dateRange: Date[] = [];
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      dateRange.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }

    for (const date of dateRange) {
      try {
        await this.pullAnalyticsData(date);
      } catch (error: any) {
        this.logger.error(
          `Error pulling post analytics data for date ${date}`,
          error,
          error.stack,
        );
      }
    }
  }

  async pullAnalyticsData(date: Date) {
    const startOfDay = moment(date).startOf('day').toDate();
    const endOfDay = moment(date).endOf('day').toDate();
    const analyticsData = await this.getDateAnalytics(startOfDay, endOfDay);
    await this.postAnalyticsRepository.delete({
      date: startOfDay,
    });
    return this.postAnalyticsRepository.insert(analyticsData);
  }

  async getDateAnalytics(
    startOfDay: Date,
    endOfDay: Date,
    senderAddress?: string,
  ): Promise<DatePostAnalyticsRow> {
    const params: any[] = [startOfDay, endOfDay];
    let senderFilter = '';
    if (senderAddress) {
      params.push(senderAddress);
      senderFilter = ' AND sender_address = $3';
    }

    const [agg] = await this.postsRepository.query(
      `SELECT
         COUNT(*) FILTER (WHERE post_id IS NULL)::int                AS total_posts,
         COUNT(*) FILTER (WHERE post_id IS NOT NULL)::int            AS total_comments,
         COUNT(*)::int                                               AS total_all,
         COUNT(DISTINCT sender_address)::int                         AS total_unique_posters,
         COALESCE(AVG(total_comments) FILTER (WHERE post_id IS NULL), 0) AS avg_comments_per_post
       FROM posts
       WHERE created_at BETWEEN $1 AND $2 AND is_hidden = false${senderFilter}`,
      params,
    );

    const cumulativeWhere: string[] = [
      'created_at < $1',
      'is_hidden = false',
      'post_id IS NULL',
    ];
    const cumulativeParams: any[] = [endOfDay];
    if (senderAddress) {
      cumulativeParams.push(senderAddress);
      cumulativeWhere.push('sender_address = $2');
    }
    const [cumulative] = await this.postsRepository.query(
      `SELECT COUNT(*)::int AS total
       FROM posts
       WHERE ${cumulativeWhere.join(' AND ')}`,
      cumulativeParams,
    );

    return {
      date: moment(startOfDay).format('YYYY-MM-DD'),
      total_posts: Number(agg?.total_posts ?? 0),
      total_comments: Number(agg?.total_comments ?? 0),
      total_all: Number(agg?.total_all ?? 0),
      total_unique_posters: Number(agg?.total_unique_posters ?? 0),
      cumulative_total_posts: Number(cumulative?.total ?? 0),
      avg_comments_per_post: Number(agg?.avg_comments_per_post ?? 0),
    };
  }

  /**
   * Compute a per-day series live (no caching) - used when filtering by sender_address
   * for arbitrary ranges. Uses a single GROUP BY query.
   */
  async getDateRangeAnalyticsLive(
    startDate: Date,
    endDate: Date,
    senderAddress?: string,
  ): Promise<DatePostAnalyticsRow[]> {
    const startOfRange = moment(startDate).startOf('day').toDate();
    const endOfRange = moment(endDate).endOf('day').toDate();

    const params: any[] = [startOfRange, endOfRange];
    let senderFilter = '';
    if (senderAddress) {
      params.push(senderAddress);
      senderFilter = ' AND sender_address = $3';
    }

    const rows: Array<{
      day: Date;
      total_posts: string | number;
      total_comments: string | number;
      total_all: string | number;
      total_unique_posters: string | number;
      avg_comments_per_post: string | number;
    }> = await this.postsRepository.query(
      `SELECT
         date_trunc('day', created_at) AS day,
         COUNT(*) FILTER (WHERE post_id IS NULL)::int                AS total_posts,
         COUNT(*) FILTER (WHERE post_id IS NOT NULL)::int            AS total_comments,
         COUNT(*)::int                                               AS total_all,
         COUNT(DISTINCT sender_address)::int                         AS total_unique_posters,
         COALESCE(AVG(total_comments) FILTER (WHERE post_id IS NULL), 0) AS avg_comments_per_post
       FROM posts
       WHERE created_at BETWEEN $1 AND $2 AND is_hidden = false${senderFilter}
       GROUP BY day
       ORDER BY day ASC`,
      params,
    );

    if (rows.length === 0) {
      return [];
    }

    // cumulative totals: one query for the cumulative count up to each day's end
    const dayKeys = rows.map((row) =>
      moment(row.day).startOf('day').format('YYYY-MM-DD'),
    );

    const cumulativeMap = new Map<string, number>();
    for (const dayKey of dayKeys) {
      const endOfThatDay = moment(dayKey).endOf('day').toDate();
      const cumulativeWhere: string[] = [
        'created_at < $1',
        'is_hidden = false',
        'post_id IS NULL',
      ];
      const cumulativeParams: any[] = [endOfThatDay];
      if (senderAddress) {
        cumulativeParams.push(senderAddress);
        cumulativeWhere.push('sender_address = $2');
      }
      const [cumulative] = await this.postsRepository.query(
        `SELECT COUNT(*)::int AS total
         FROM posts
         WHERE ${cumulativeWhere.join(' AND ')}`,
        cumulativeParams,
      );
      cumulativeMap.set(dayKey, Number(cumulative?.total ?? 0));
    }

    return rows.map((row) => {
      const dayKey = moment(row.day).startOf('day').format('YYYY-MM-DD');
      return {
        date: dayKey,
        total_posts: Number(row.total_posts ?? 0),
        total_comments: Number(row.total_comments ?? 0),
        total_all: Number(row.total_all ?? 0),
        total_unique_posters: Number(row.total_unique_posters ?? 0),
        cumulative_total_posts: cumulativeMap.get(dayKey) ?? 0,
        avg_comments_per_post: Number(row.avg_comments_per_post ?? 0),
      };
    });
  }

  async getTopPosters(
    startDate: Date,
    endDate: Date,
    limit: number = 10,
  ): Promise<
    Array<{
      sender_address: string;
      total_posts: number;
      total_comments: number;
      total_all: number;
    }>
  > {
    const startOfRange = moment(startDate).startOf('day').toDate();
    const endOfRange = moment(endDate).endOf('day').toDate();

    const safeLimit = Math.max(1, Math.min(limit, 100));

    const rows: Array<{
      sender_address: string;
      total_posts: string | number;
      total_comments: string | number;
      total_all: string | number;
    }> = await this.postsRepository.query(
      `SELECT
         sender_address,
         COUNT(*) FILTER (WHERE post_id IS NULL)::int     AS total_posts,
         COUNT(*) FILTER (WHERE post_id IS NOT NULL)::int AS total_comments,
         COUNT(*)::int                                    AS total_all
       FROM posts
       WHERE created_at BETWEEN $1 AND $2 AND is_hidden = false
       GROUP BY sender_address
       ORDER BY total_all DESC
       LIMIT $3`,
      [startOfRange, endOfRange, safeLimit],
    );

    return rows.map((row) => ({
      sender_address: row.sender_address,
      total_posts: Number(row.total_posts ?? 0),
      total_comments: Number(row.total_comments ?? 0),
      total_all: Number(row.total_all ?? 0),
    }));
  }

  async getTopTopics(
    startDate: Date,
    endDate: Date,
    limit: number = 10,
  ): Promise<
    Array<{
      topic_id: string;
      topic_name: string;
      post_count: number;
    }>
  > {
    const startOfRange = moment(startDate).startOf('day').toDate();
    const endOfRange = moment(endDate).endOf('day').toDate();

    const safeLimit = Math.max(1, Math.min(limit, 100));

    const rows: Array<{
      topic_id: string;
      topic_name: string;
      post_count: string | number;
    }> = await this.postsRepository.query(
      `SELECT
         t.id          AS topic_id,
         t.name        AS topic_name,
         COUNT(*)::int AS post_count
       FROM post_topics pt
       INNER JOIN topics t ON t.id = pt.topic_id
       INNER JOIN posts p  ON p.id = pt.post_id
       WHERE p.created_at BETWEEN $1 AND $2 AND p.is_hidden = false
       GROUP BY t.id, t.name
       ORDER BY post_count DESC
       LIMIT $3`,
      [startOfRange, endOfRange, safeLimit],
    );

    return rows.map((row) => ({
      topic_id: row.topic_id,
      topic_name: row.topic_name,
      post_count: Number(row.post_count ?? 0),
    }));
  }

  /**
   * Get the most recent cumulative_total_posts for the unfiltered series, to
   * surface a "Total Posts (all time, top-level)" stat without scanning the table.
   */
  async getLatestCumulativeTotal(): Promise<number> {
    const latest = await this.postAnalyticsRepository.findOne({
      where: {},
      order: { date: 'DESC' },
    });
    return latest?.cumulative_total_posts ?? 0;
  }

  /**
   * Live count of all top-level posts up to a given date (inclusive end-of-day).
   * Used as a fallback for filtered/sender-specific cumulative computation.
   */
  async countTopLevelPostsBefore(
    date: Date,
    senderAddress?: string,
  ): Promise<number> {
    const where: any = {
      created_at: LessThan(moment(date).endOf('day').toDate()),
      is_hidden: false,
      post_id: null as any,
    };
    if (senderAddress) {
      where.sender_address = senderAddress;
    }
    return this.postsRepository.count({ where });
  }
}
