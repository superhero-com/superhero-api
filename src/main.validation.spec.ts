import { ValidationPipe } from '@nestjs/common';
import { CreateAffiliationDto } from './affiliation/dto/create-affiliation.dto';
import { GetLeaderboardQueryDto } from './account/dto/get-leaderboard-query.dto';
import { GetPnlQueryDto } from './account/dto/get-pnl-query.dto';
import { GetPortfolioHistoryQueryDto } from './account/dto/get-portfolio-history-query.dto';
import {
  DailyTradeVolumeQueryDto,
  DailyUniqueActiveUsersQueryDto,
} from './transactions/dto/analytics-transactions.dto';
import { CreateXAttestationDto } from './profile/dto/create-x-attestation.dto';
import { CreateXInviteDto } from './profile/dto/create-x-invite.dto';
import { CreateXInviteChallengeDto } from './profile/dto/create-x-invite-challenge.dto';
import { BindXInviteDto } from './profile/dto/bind-x-invite.dto';
import { CreateXPostingRecheckChallengeDto } from './profile/dto/create-x-posting-recheck-challenge.dto';
import { SubmitXPostingRecheckDto } from './profile/dto/submit-x-posting-recheck.dto';
import { CreateTrendingTagsDto } from './trending-tags/dto/create-trending-tags.dto';
import { PopularPostsQueryDto } from './social/dto';

describe('global ValidationPipe request DTO coverage', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  const validAddress = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';

  const cases = [
    {
      name: 'CreateAffiliationDto',
      metatype: CreateAffiliationDto,
      type: 'body' as const,
      validPayload: {
        sender_address: validAddress,
        codes: ['code1', 'code2'],
      },
    },
    {
      name: 'CreateXAttestationDto',
      metatype: CreateXAttestationDto,
      type: 'body' as const,
      validPayload: {
        address: validAddress,
        accessToken: 'token-value-12345',
      },
    },
    {
      name: 'CreateXInviteDto',
      metatype: CreateXInviteDto,
      type: 'body' as const,
      validPayload: {
        inviter_address: validAddress,
        challenge_nonce: 'a'.repeat(24),
        challenge_expires_at: '123',
        signature_hex: 'b'.repeat(128),
      },
    },
    {
      name: 'CreateXInviteChallengeDto',
      metatype: CreateXInviteChallengeDto,
      type: 'body' as const,
      validPayload: {
        address: validAddress,
        purpose: 'create',
      },
    },
    {
      name: 'BindXInviteDto',
      metatype: BindXInviteDto,
      type: 'body' as const,
      validPayload: {
        invitee_address: validAddress,
        challenge_nonce: 'c'.repeat(24),
        challenge_expires_at: '456',
        signature_hex: 'd'.repeat(128),
      },
    },
    {
      name: 'CreateXPostingRecheckChallengeDto',
      metatype: CreateXPostingRecheckChallengeDto,
      type: 'body' as const,
      validPayload: {
        address: validAddress,
      },
    },
    {
      name: 'SubmitXPostingRecheckDto',
      metatype: SubmitXPostingRecheckDto,
      type: 'body' as const,
      validPayload: {
        challenge_nonce: 'ab12cd34',
        challenge_expires_at: '789',
        signature_hex: 'e'.repeat(128),
      },
    },
    {
      name: 'CreateTrendingTagsDto',
      metatype: CreateTrendingTagsDto,
      type: 'body' as const,
      validPayload: {
        provider: 'x',
        items: [{ tag: 'blockchain', score: '95.5' }],
      },
      extraPayload: {
        provider: 'x',
        items: [{ tag: 'blockchain', score: '95.5', extra: 'boom' }],
      },
    },
    {
      name: 'GetPnlQueryDto',
      metatype: GetPnlQueryDto,
      type: 'query' as const,
      validPayload: {
        blockHeight: '123',
      },
      assertTransformed(result: GetPnlQueryDto) {
        expect(result.blockHeight).toBe(123);
      },
    },
    {
      name: 'GetPortfolioHistoryQueryDto',
      metatype: GetPortfolioHistoryQueryDto,
      type: 'query' as const,
      validPayload: {
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-12-31T23:59:59.999Z',
        interval: '86400',
        convertTo: 'usd',
        include: 'pnl',
      },
      assertTransformed(result: GetPortfolioHistoryQueryDto) {
        expect(result.interval).toBe(86400);
      },
    },
    {
      name: 'GetLeaderboardQueryDto',
      metatype: GetLeaderboardQueryDto,
      type: 'query' as const,
      validPayload: {
        window: '7d',
        sortBy: 'pnl',
        sortDir: 'desc',
        page: '2',
        limit: '20',
        minAumUsd: '1',
        timePeriod: '30',
        timeUnit: 'minutes',
      },
      assertTransformed(result: GetLeaderboardQueryDto) {
        expect(result.page).toBe(2);
        expect(result.limit).toBe(20);
        expect(result.minAumUsd).toBe(1);
        expect(result.timePeriod).toBe(30);
        expect(result.sortDir).toBe('DESC');
      },
    },
    {
      name: 'PopularPostsQueryDto',
      metatype: PopularPostsQueryDto,
      type: 'query' as const,
      validPayload: {
        window: '24h',
        page: '2',
        limit: '20',
      },
      assertTransformed(result: PopularPostsQueryDto) {
        expect(result.window).toBe('24h');
        expect(result.page).toBe(2);
        expect(result.limit).toBe(20);
      },
    },
    {
      name: 'DailyTradeVolumeQueryDto',
      metatype: DailyTradeVolumeQueryDto,
      type: 'query' as const,
      validPayload: {
        start_date: '2024-01-01',
        end_date: '2024-01-31',
        token_address: validAddress,
        account_address: validAddress,
      },
    },
    {
      name: 'DailyUniqueActiveUsersQueryDto',
      metatype: DailyUniqueActiveUsersQueryDto,
      type: 'query' as const,
      validPayload: {
        start_date: '2024-01-01',
        end_date: '2024-01-31',
        token_address: validAddress,
      },
    },
  ];

  it.each(cases)('accepts valid $name payloads', async (testCase) => {
    const result = await pipe.transform(testCase.validPayload, {
      type: testCase.type,
      metatype: testCase.metatype,
      data: '',
    });

    testCase.assertTransformed?.(result as never);
  });

  it.each(cases)('rejects unexpected fields for $name', async (testCase) => {
    const payload = testCase.extraPayload ?? {
      ...testCase.validPayload,
      unexpected_field: 'boom',
    };

    await expect(
      pipe
        .transform(payload, {
          type: testCase.type,
          metatype: testCase.metatype,
          data: '',
        })
        .catch((error: { getResponse?: () => unknown }) => {
          throw error.getResponse?.() ?? error;
        }),
    ).rejects.toMatchObject({
      message: expect.arrayContaining([
        expect.stringMatching(/should not exist/),
      ]),
    });
  });

  it('rejects invalid SDK-backed account address fields', async () => {
    await expect(
      pipe
        .transform(
          {
            sender_address: '100',
            codes: ['code1'],
          },
          {
            type: 'body',
            metatype: CreateAffiliationDto,
            data: '',
          },
        )
        .catch((error: { getResponse?: () => unknown }) => {
          throw error.getResponse?.() ?? error;
        }),
    ).rejects.toMatchObject({
      message: expect.arrayContaining([
        expect.stringMatching(/sender_address must be a valid account address/),
      ]),
    });
  });
});
