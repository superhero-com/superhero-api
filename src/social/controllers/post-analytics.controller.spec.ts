import { BadRequestException } from '@nestjs/common';
import { PostAnalyticsController } from './post-analytics.controller';

describe('PostAnalyticsController', () => {
  let controller: PostAnalyticsController;
  let cacheDailyPostAnalyticsService: {
    getDateRangeAnalyticsLive: jest.Mock;
    getDateAnalytics: jest.Mock;
    getTopPosters: jest.Mock;
    getTopTopics: jest.Mock;
  };

  beforeEach(() => {
    cacheDailyPostAnalyticsService = {
      getDateRangeAnalyticsLive: jest.fn().mockResolvedValue([]),
      getDateAnalytics: jest.fn().mockResolvedValue([]),
      getTopPosters: jest.fn().mockResolvedValue([]),
      getTopTopics: jest.fn().mockResolvedValue([]),
    };

    controller = new PostAnalyticsController(
      cacheDailyPostAnalyticsService as any,
      {} as any,
    );
  });

  describe('getPostsAnalyticsData', () => {
    it('rejects an invalid start_date', async () => {
      await expect(
        controller.getPostsAnalyticsData('not-a-date', undefined, undefined),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an invalid end_date', async () => {
      await expect(
        controller.getPostsAnalyticsData(undefined, 'not-a-date', undefined),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getTopPosters', () => {
    it('rejects an invalid start_date', async () => {
      await expect(
        controller.getTopPosters('not-a-date', undefined, 10),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getTopTopics', () => {
    it('rejects an invalid start_date', async () => {
      await expect(
        controller.getTopTopics('not-a-date', undefined, 10),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
