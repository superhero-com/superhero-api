import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Header,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiOkResponse,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import moment from 'moment';
import { paginate } from 'nestjs-typeorm-paginate';
import { Brackets, Repository } from 'typeorm';
import { Account } from '../entities/account.entity';
import { PortfolioService } from '../services/portfolio.service';
import { BclPnlService } from '../services/bcl-pnl.service';
import { AccountService } from '../services/account.service';
import { GetPortfolioHistoryQueryDto } from '../dto/get-portfolio-history-query.dto';
import { PortfolioHistorySnapshotDto } from '../dto/portfolio-history-response.dto';
import { TradingStatsQueryDto } from '../dto/trading-stats-query.dto';
import { TradingStatsResponseDto } from '../dto/trading-stats-response.dto';
import { NostrAccountRefDto } from '../dto/nostr-account-ref.dto';
import { AccountSearchResultDto } from '../dto/account-search-result.dto';
import { normalizePubkey } from '@/token-gated-rooms/nostr/pubkey';
import { ProfileReadService } from '@/profile/services/profile-read.service';
import { ProfileCache } from '@/profile/entities/profile-cache.entity';
import {
  buildSparklineSvg,
  parseSvgDimension,
  sparklineStroke,
} from '@/utils/sparkline.util';
import {
  AeAccountAddressPipe,
  AeAccountReferencePipe,
  isAeAccountAddress,
} from '@/common/validation/request-validation';

const ALLOWED_ORDER_BY = new Set([
  'total_volume',
  'total_tx_count',
  'total_buy_tx_count',
  'total_sell_tx_count',
  'total_created_tokens',
  'total_invitation_count',
  'total_claimed_invitation_count',
  'total_revoked_invitation_count',
  'created_at',
]);
const ALLOWED_ORDER_DIRECTIONS = new Set(['ASC', 'DESC']);
const MAX_SEARCH_LENGTH = 100;
// Upper bound on the raw `addresses` CSV before we split/dedupe/validate, so
// an oversized query string can't force unbounded parse work. Comfortably fits
// the 25 addresses we actually resolve (~54 chars each + commas); the rest is
// silently dropped, consistent with the "at most 25 resolved" contract.
const MAX_ADDRESSES_CSV_LENGTH = 2000;

@UseInterceptors(CacheInterceptor)
@Controller('accounts')
@ApiTags('Accounts')
export class AccountsController {
  private readonly logger = new Logger(AccountsController.name);

  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    private readonly portfolioService: PortfolioService,
    private readonly bclPnlService: BclPnlService,
    private readonly accountService: AccountService,
    private readonly profileReadService: ProfileReadService,
  ) {
    //
  }

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'search',
    type: 'string',
    required: false,
    description: 'Search accounts by address or name',
  })
  @ApiQuery({
    name: 'order_by',
    enum: [
      'total_volume',
      'total_tx_count',
      'total_buy_tx_count',
      'total_sell_tx_count',
      'total_created_tokens',
      'total_invitation_count',
      'total_claimed_invitation_count',
      'total_revoked_invitation_count',
      'created_at',
    ],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiQuery({
    name: 'has_nostr',
    type: 'boolean',
    required: false,
    description:
      'When true, only return accounts that have linked a Nostr key ' +
      "(`links->>'nostr' IS NOT NULL`) — e.g. to suggest chat contacts.",
  })
  @ApiOperation({ operationId: 'listAll' })
  @CacheTTL(60_000)
  @Get()
  async listAll(
    @Query('search') search: string | undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'total_volume',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
    @Query('has_nostr') hasNostr?: string,
  ) {
    if (page < 1) {
      throw new BadRequestException('Page must be greater than or equal to 1');
    }
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('Limit must be between 1 and 100');
    }
    if (!ALLOWED_ORDER_BY.has(orderBy)) {
      throw new BadRequestException(`Invalid order_by value: ${orderBy}`);
    }
    if (!ALLOWED_ORDER_DIRECTIONS.has(orderDirection)) {
      throw new BadRequestException(
        `Invalid order_direction value: ${orderDirection}`,
      );
    }
    if (search && search.length > MAX_SEARCH_LENGTH) {
      throw new BadRequestException(
        `search must be at most ${MAX_SEARCH_LENGTH} characters`,
      );
    }

    const trimmedSearch = search?.trim();
    if (trimmedSearch && isAeAccountAddress(trimmedSearch)) {
      await this.tryHydrateAccountFromTransactions(trimmedSearch);
    }

    const query = this.accountRepository.createQueryBuilder('account');

    if (search?.trim()) {
      const normalizedSearch = `%${search.trim()}%`;
      query.leftJoin(
        ProfileCache,
        'profile_cache',
        'profile_cache.address = account.address',
      );
      query.andWhere(
        new Brackets((qb) => {
          qb.where('account.address ILIKE :search', {
            search: normalizedSearch,
          })
            .orWhere('account.chain_name ILIKE :search', {
              search: normalizedSearch,
            })
            .orWhere('profile_cache.public_name ILIKE :search', {
              search: normalizedSearch,
            })
            .orWhere('profile_cache.chain_name ILIKE :search', {
              search: normalizedSearch,
            })
            .orWhere('profile_cache.username ILIKE :search', {
              search: normalizedSearch,
            })
            .orWhere('profile_cache.fullname ILIKE :search', {
              search: normalizedSearch,
            });
        }),
      );
    }

    // Chat-contact suggestions: only accounts that linked a Nostr key can be
    // messaged, so allow filtering the list down to them. `links` is a `jsonb`
    // column; `->>'nostr'` extracts the linked npub/hex (NULL when absent).
    if (hasNostr === 'true' || hasNostr === '1') {
      query.andWhere("account.links->>'nostr' IS NOT NULL");
      query.andWhere("account.links->>'nostr' <> ''");
    }

    if (orderBy) {
      query.orderBy(`account.${orderBy}`, orderDirection);
    }
    return paginate(query, { page, limit });
  }

  /**
   * Reverse lookup: resolve nostr pubkeys → the aeternity accounts that linked
   * them, so a client can show the AE identity (chain name / `ak_`) for a nostr
   * pubkey instead of the raw hex (e.g. a NIP-29 group's member list + membership
   * system lines). `pubkeys` is a CSV of npub/hex (each normalized to hex; an
   * `npub` and its hex resolve identically). Only matched accounts are returned —
   * unlinked pubkeys are simply absent. Declared before `:address` so the literal
   * segment isn't captured as an address param.
   *
   * `links->>'nostr'` may store hex OR npub, so we can't match the raw value in
   * SQL; we narrow to nostr-linked accounts then normalize each in memory (same
   * approach as `IdentityService.getAddressForPubkey`). The nostr-linked set is
   * small today; revisit with a hex+npub `IN (…)` filter if it grows.
   */
  @ApiOperation({ operationId: 'resolveByNostr' })
  @ApiQuery({
    name: 'pubkeys',
    type: 'string',
    required: true,
    description:
      'Comma-separated nostr pubkeys (npub or 64-char hex), max 200.',
  })
  @ApiOkResponse({ type: [NostrAccountRefDto] })
  @CacheTTL(60_000)
  @Get('by-nostr')
  async resolveByNostr(
    @Query('pubkeys') pubkeysCsv?: string,
  ): Promise<NostrAccountRefDto[]> {
    const requested = (pubkeysCsv ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!requested.length) return [];
    if (requested.length > 200) {
      throw new BadRequestException('At most 200 pubkeys per request');
    }

    // Target set: normalized hex pubkeys we were asked about.
    const wanted = new Set<string>();
    for (const p of requested) {
      const hex = normalizePubkey(p);
      if (hex) wanted.add(hex);
    }
    if (!wanted.size) return [];

    const candidates = await this.accountRepository
      .createQueryBuilder('account')
      .select(['account.address', 'account.chain_name', 'account.links'])
      .where("account.links->>'nostr' IS NOT NULL")
      .andWhere("account.links->>'nostr' <> ''")
      .getMany();

    const out: NostrAccountRefDto[] = [];
    const seen = new Set<string>();
    for (const account of candidates) {
      const hex = normalizePubkey(account.links?.nostr);
      if (hex && wanted.has(hex) && !seen.has(hex)) {
        seen.add(hex);
        out.push({
          nostr_pubkey: hex,
          address: account.address,
          chain_name: account.chain_name ?? null,
        });
      }
    }
    return out;
  }

  /**
   * Typeahead search for account autocomplete (search by chain name /
   * address). Declared before `:address` so the literal segment isn't
   * captured as an address param.
   */
  @ApiOperation({
    operationId: 'searchAccounts',
    summary: 'Typeahead search for accounts by address or chain name',
    description:
      'Powers account autocomplete. Returns `[]` when `q` is missing or blank.',
  })
  @ApiQuery({
    name: 'q',
    type: 'string',
    required: false,
    description: `Search term (address or chain name substring), max ${MAX_SEARCH_LENGTH} characters.`,
  })
  @ApiQuery({
    name: 'limit',
    type: 'number',
    required: false,
    description: 'Max results, clamped to 1-20 (default 8).',
  })
  @ApiOkResponse({ type: [AccountSearchResultDto] })
  @CacheTTL(60_000)
  @Get('search')
  async searchAccounts(
    @Query('q') q: string | undefined,
    @Query('limit', new DefaultValuePipe(8), ParseIntPipe) limit = 8,
  ): Promise<AccountSearchResultDto[]> {
    if (q && q.length > MAX_SEARCH_LENGTH) {
      throw new BadRequestException(
        `q must be at most ${MAX_SEARCH_LENGTH} characters`,
      );
    }
    return this.accountService.searchByNameOrAddress(q, limit);
  }

  /**
   * Batch chain-name resolver, e.g. for a comparison page that needs the
   * chain name (or lack thereof) for a fixed list of addresses in one call.
   * Declared before `:address` so the literal segment isn't captured as an
   * address param.
   */
  @ApiOperation({
    operationId: 'getChainNamesForAddresses',
    summary: 'Batch resolve chain names for a list of addresses',
    description:
      'Every requested valid address is present in the result, mapped to ' +
      'its chain name or `null` when unknown / unset. Invalid addresses ' +
      'are silently dropped; at most 25 are resolved.',
  })
  @ApiQuery({
    name: 'addresses',
    type: 'string',
    required: true,
    description: 'Comma-separated account addresses, max 25 resolved.',
  })
  @ApiOkResponse({
    description: 'Map of address -> chain_name (string) or null.',
  })
  @CacheTTL(60_000)
  @Get('chain-names')
  async getChainNamesForAddresses(
    @Query('addresses') addressesCsv?: string,
  ): Promise<Record<string, string | null>> {
    const requested = (addressesCsv ?? '')
      .slice(0, MAX_ADDRESSES_CSV_LENGTH)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const deduped = Array.from(new Set(requested));
    const valid = deduped.filter((address) => isAeAccountAddress(address));

    if (!valid.length) {
      return {};
    }

    return this.accountService.getChainNamesForAddresses(valid);
  }

  /**
   * Calculate minimum allowed interval based on the period between start and end dates
   * @param start Start date moment object
   * @param end End date moment object
   * @returns Minimum interval in seconds
   */
  private getMinimumInterval(
    start?: moment.Moment,
    end?: moment.Moment,
  ): number {
    if (!start || !end) {
      // If no dates provided, default to daily interval
      return 86400;
    }

    const periodMonths = end.diff(start, 'months', true);

    // If period is in days or weeks (less than 1 month), hourly interval is okay
    if (periodMonths < 1) {
      return 3600; // 1 hour
    }

    // If period is 1-3 months, minimum 4 hour interval
    if (periodMonths >= 1 && periodMonths < 3) {
      return 14400; // 4 hours
    }

    // If period is 3-6 months, minimum 1 day interval
    if (periodMonths >= 3 && periodMonths < 6) {
      return 86400; // 1 day
    }

    // If period is 6+ months, minimum 1 week interval
    return 604800; // 1 week
  }

  // Portfolio history endpoint - MUST come before :address route to avoid route conflict
  @ApiOperation({
    operationId: 'getPortfolioHistory',
    summary: 'Portfolio value history snapshots',
    description:
      'Returns portfolio value over time (AE balance, token values, total value). ' +
      'Pass include=pnl or include=pnl-range to add aggregate total_pnl data. ' +
      'Per-token PnL breakdown (tokens_pnl) is available via the dedicated :address/portfolio/tokens/history endpoint.',
  })
  @ApiParam({ name: 'address', type: 'string', description: 'Account address' })
  @ApiOkResponse({ type: [PortfolioHistorySnapshotDto] })
  @CacheTTL(10 * 60_000)
  @Get(':address/portfolio/history')
  async getPortfolioHistory(
    //
    @Param('address', AeAccountReferencePipe) address: string,
    @Query() query: GetPortfolioHistoryQueryDto,
  ) {
    const start = query.startDate ? moment(query.startDate) : undefined;
    const end = query.endDate ? moment(query.endDate) : undefined;
    const includeFields = query.include
      ? query.include.split(',').map((f) => f.trim())
      : [];

    // Calculate minimum allowed interval based on period
    const minimumInterval = this.getMinimumInterval(start, end);
    const requestedInterval = query.interval || 86400;

    // Use the larger of requested interval or minimum allowed interval
    const finalInterval = Math.max(requestedInterval, minimumInterval);

    const includePnl =
      includeFields.includes('pnl') || includeFields.includes('pnl-range');
    const useRangeBasedPnl = includeFields.includes('pnl-range');

    return await this.portfolioService.getPortfolioHistory(address, {
      startDate: start,
      endDate: end,
      interval: finalInterval,
      convertTo: query.convertTo || 'ae',
      includePnl,
      useRangeBasedPnl,
    });
  }

  @ApiOperation({
    operationId: 'getTokensPnlHistory',
    summary: 'Per-token PnL history snapshots',
    description:
      'Returns portfolio history snapshots that include the per-token PnL breakdown (tokens_pnl). ' +
      'PnL data is always included; pass include=pnl-range to use range-based (daily window) PnL instead of cumulative.',
  })
  @ApiParam({ name: 'address', type: 'string', description: 'Account address' })
  @ApiOkResponse({ type: [PortfolioHistorySnapshotDto] })
  @CacheTTL(10 * 60_000)
  @Get(':address/portfolio/tokens/history')
  async getTokensPnlHistory(
    @Param('address', AeAccountReferencePipe) address: string,
    @Query() query: GetPortfolioHistoryQueryDto,
  ) {
    const start = query.startDate ? moment(query.startDate) : undefined;
    const end = query.endDate ? moment(query.endDate) : undefined;
    const includeFields = query.include
      ? query.include.split(',').map((f) => f.trim())
      : [];

    const minimumInterval = this.getMinimumInterval(start, end);
    const requestedInterval = query.interval || 86400;
    const finalInterval = Math.max(requestedInterval, minimumInterval);

    const useRangeBasedPnl = includeFields.includes('pnl-range');

    return await this.portfolioService.getPortfolioHistory(address, {
      startDate: start,
      endDate: end,
      interval: finalInterval,
      convertTo: query.convertTo || 'ae',
      includePnl: true,
      useRangeBasedPnl,
      includeTokensPnl: true,
    });
  }

  // Portfolio PnL sparkline — MUST come before :address route to avoid route conflict
  @ApiOperation({
    operationId: 'getPortfolioPnlChart',
    summary:
      'SVG sparkline of daily (or hourly for a single-day range) realized PnL',
  })
  @ApiParam({ name: 'address', type: 'string', description: 'Account address' })
  @ApiQuery({ name: 'startDate', type: 'string', required: false })
  @ApiQuery({ name: 'endDate', type: 'string', required: false })
  @ApiQuery({
    name: 'convertTo',
    enum: ['ae', 'usd'],
    required: false,
    example: 'ae',
  })
  @ApiQuery({ name: 'width', type: 'number', required: false, example: 160 })
  @ApiQuery({ name: 'height', type: 'number', required: false, example: 60 })
  @ApiQuery({
    name: 'background',
    type: 'string',
    required: false,
    example: 'none',
    description: 'CSS fill for background rect, e.g. "#1a1a2e" or "none"',
  })
  @Header('Content-Type', 'image/svg+xml')
  @Header('Content-Disposition', 'inline; filename="pnl-chart.svg"')
  @CacheTTL(10 * 60_000)
  @Get(':address/portfolio/pnl-chart.svg')
  async getPortfolioPnlChart(
    @Param('address', AeAccountReferencePipe) address: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('convertTo') convertTo: 'ae' | 'usd' = 'ae',
    @Query('width') width = '160',
    @Query('height') height = '60',
    @Query('background') background = 'none',
  ): Promise<StreamableFile> {
    const start = startDate ? moment(startDate) : moment().subtract(30, 'days');
    const end = endDate ? moment(endDate) : moment();

    // Use hourly points for a single-day range, daily otherwise
    const rangeHours = end.diff(start, 'hours', true);
    const interval = rangeHours <= 24 ? 3600 : 86400;

    // Use the lightweight PnL-only series instead of the full portfolio history.
    // This skips AE-node balance calls, block-height resolution, and cumulative
    // PnL queries — only calculateDailyPnlBatch (one SQL query) runs.
    // resolveAccountAddress is handled inside getPnlTimeSeries.
    const points = await this.portfolioService.getPnlTimeSeries(address, {
      startDate: start,
      endDate: end,
      interval,
    });

    const values = points.map((p) => p.gain[convertTo]);

    const svg = buildSparklineSvg(
      values,
      parseSvgDimension(width, 160),
      parseSvgDimension(height, 60),
      sparklineStroke(values),
      background,
    );

    return new StreamableFile(Buffer.from(svg), {
      type: 'image/svg+xml',
      disposition: 'inline; filename="pnl-chart.svg"',
    });
  }

  // Portfolio stats endpoint - MUST come before :address route to avoid route conflict
  @ApiOperation({ operationId: 'getPortfolioStats' })
  @ApiParam({ name: 'address', type: 'string', description: 'Account address' })
  @ApiOkResponse({ type: TradingStatsResponseDto })
  @CacheTTL(10 * 60_000)
  @Get(':address/portfolio/stats')
  async getPortfolioStats(
    @Param('address', AeAccountReferencePipe) address: string,
    @Query() query: TradingStatsQueryDto,
  ): Promise<TradingStatsResponseDto> {
    const start = query.startDate
      ? moment(query.startDate).toDate()
      : moment().subtract(30, 'days').toDate();
    const end = query.endDate ? moment(query.endDate).toDate() : new Date();

    const resolvedAddress =
      await this.portfolioService.resolveAccountAddress(address);

    const stats = await this.bclPnlService.calculateTradingStats(
      resolvedAddress,
      start,
      end,
    );

    return {
      top_win: stats.topWin,
      unrealized_profit: stats.unrealizedProfit,
      win_rate: stats.winRate,
      avg_duration_seconds: stats.avgDurationSeconds,
      total_trades: stats.totalTrades,
      winning_trades: stats.winningTrades,
    };
  }

  // single account - MUST come after more specific routes
  @ApiOperation({ operationId: 'getAccount' })
  @ApiParam({ name: 'address', type: 'string' })
  @CacheTTL(10 * 60_000)
  @Get(':address')
  async getAccount(@Param('address', AeAccountAddressPipe) address: string) {
    const account =
      (await this.tryHydrateAccountFromTransactions(address)) ??
      (await this.accountRepository.findOne({
        where: { address },
      }));

    if (!account) {
      throw new NotFoundException('Account not found');
    }

    // Fetch chain name from middleware if stale (older than 24 hours) or never checked
    const CHAIN_NAME_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
    const now = new Date();
    const isStale = account.chain_name_updated_at
      ? now.getTime() - account.chain_name_updated_at.getTime() >
        CHAIN_NAME_STALE_THRESHOLD_MS
      : true;

    let chainName = account.chain_name;
    let chainNameUpdatedAt = account.chain_name_updated_at;

    if (isStale) {
      const fetchedChainName =
        await this.accountService.getChainNameForAccount(address);

      if (fetchedChainName !== undefined) {
        chainName = fetchedChainName;
        chainNameUpdatedAt = now;
        const updateData: Partial<Account> = {
          chain_name: chainName,
          chain_name_updated_at: now,
        };
        this.accountRepository.update(address, updateData).catch((err) => {
          this.logger.warn(`Failed to update chain_name for ${address}`, err);
        });
      }
    }

    const profile = await this.profileReadService.getProfile(address);

    return {
      ...account,
      chain_name: chainName,
      chain_name_updated_at: chainNameUpdatedAt,
      profile: profile.profile,
      public_name: profile.public_name,
    };
  }

  private async tryHydrateAccountFromTransactions(
    address: string,
  ): Promise<Account | null> {
    try {
      return await this.accountService.ensureAccountFromTransactions(address);
    } catch (error) {
      this.logger.error(
        `Failed to hydrate account from transactions for ${address}`,
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }
}
