import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpException,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProfileReadService } from '@/profile/services/profile-read.service';
import { SocialGraphContractService } from './social-graph-contract.service';
import { SocialGraphConfiguredGuard } from './social-graph-configured.guard';
import { SocialGraphService } from './social-graph.service';
import { SOCIAL_GRAPH_ABORT_STATUS } from './social-graph.errors';
import {
  AE_ADDRESS_REGEX,
  SocialGraphConfigDto,
  SocialGraphConnectionsPageDto,
  SocialGraphPrecheckDto,
  SocialGraphRelationshipDto,
} from './dto/social-graph.dto';

const MAX_LIST_LIMIT = 100;
const MAX_LIST_SEARCH_LENGTH = 100;

@ApiTags('Social Graph')
@Controller('social-graph')
@UseGuards(SocialGraphConfiguredGuard)
export class SocialGraphController {
  constructor(
    private readonly socialGraphService: SocialGraphService,
    private readonly contractService: SocialGraphContractService,
    private readonly profileReadService: ProfileReadService,
  ) {}

  @Get('followers')
  @ApiOperation({
    operationId: 'listSocialGraphFollowers',
    summary: "An account's followers, newest first, searchable and paged",
  })
  @ApiQuery({ name: 'address', required: true, example: 'ak_...' })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Filter by address, chain name or profile name.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Opaque cursor from a previous page; omit for the first page.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `Page size, 1-${MAX_LIST_LIMIT} (default 20).`,
  })
  @ApiResponse({ status: 200, type: SocialGraphConnectionsPageDto })
  @ApiResponse({ status: 400, description: 'Invalid address or query.' })
  @ApiResponse({ status: 503, description: 'Contract not configured.' })
  listFollowers(
    @Query('address') address: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ): Promise<SocialGraphConnectionsPageDto> {
    return this.listConnections('followers', address, search, cursor, limit);
  }

  @Get('following')
  @ApiOperation({
    operationId: 'listSocialGraphFollowing',
    summary: 'Accounts an account follows, newest first, searchable and paged',
  })
  @ApiQuery({ name: 'address', required: true, example: 'ak_...' })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Filter by address, chain name or profile name.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Opaque cursor from a previous page; omit for the first page.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `Page size, 1-${MAX_LIST_LIMIT} (default 20).`,
  })
  @ApiResponse({ status: 200, type: SocialGraphConnectionsPageDto })
  @ApiResponse({ status: 400, description: 'Invalid address or query.' })
  @ApiResponse({ status: 503, description: 'Contract not configured.' })
  listFollowing(
    @Query('address') address: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ): Promise<SocialGraphConnectionsPageDto> {
    return this.listConnections('following', address, search, cursor, limit);
  }

  private async listConnections(
    direction: 'followers' | 'following',
    address: string,
    search: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<SocialGraphConnectionsPageDto> {
    this.assertAddress(address, 'address');
    if (limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new BadRequestException(
        `limit must be between 1 and ${MAX_LIST_LIMIT}`,
      );
    }
    if (search && search.length > MAX_LIST_SEARCH_LENGTH) {
      throw new BadRequestException(
        `search must be at most ${MAX_LIST_SEARCH_LENGTH} characters`,
      );
    }
    const parsedCursor = this.parseCursor(cursor);

    const { addresses, nextCursor } =
      await this.socialGraphService.listConnections({
        address,
        direction,
        search,
        cursor: parsedCursor,
        limit,
      });

    // One batched profile read for the whole page — the "no per-row lookup"
    // the list rows need. Re-key by address to keep the edge (cursor) order.
    const profiles =
      await this.profileReadService.getProfilesByAddresses(addresses);
    const byAddress = new Map(profiles.map((p) => [p.address, p]));
    const items = addresses.map(
      (addr) => byAddress.get(addr) ?? this.emptyRow(addr),
    );

    return {
      items,
      next_cursor: nextCursor === null ? null : String(nextCursor),
    };
  }

  private parseCursor(cursor: string | undefined): number | undefined {
    if (cursor === undefined || cursor === '') {
      return undefined;
    }
    const parsed = Number(cursor);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BadRequestException('Invalid cursor');
    }
    return parsed;
  }

  private emptyRow(
    address: string,
  ): SocialGraphConnectionsPageDto['items'][number] {
    return {
      address,
      profile: {
        fullname: '',
        bio: '',
        site: null,
        avatarurl: '',
        username: null,
        prefered_aens_name: null,
        x_username: null,
        chain_name: null,
        chain_expires_at: null,
      },
      public_name: address,
    };
  }

  @Get('relationship')
  @ApiOperation({
    operationId: 'getSocialGraphRelationship',
    summary: 'Pair-wise follow/block relationship between two addresses',
  })
  @ApiQuery({ name: 'from', required: true, example: 'ak_...' })
  @ApiQuery({ name: 'to', required: true, example: 'ak_...' })
  @ApiResponse({ status: 200, type: SocialGraphRelationshipDto })
  @ApiResponse({ status: 400, description: 'Invalid address.' })
  @ApiResponse({ status: 503, description: 'Contract not configured.' })
  async getRelationship(
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<SocialGraphRelationshipDto> {
    this.assertAddress(from, 'from');
    this.assertAddress(to, 'to');
    return this.socialGraphService.getRelationship(from, to);
  }

  @Get('config')
  @ApiOperation({
    operationId: 'getSocialGraphConfig',
    summary: 'Contract caps: max_following, max_blocked, follow_cooldown',
  })
  @ApiResponse({ status: 200, type: SocialGraphConfigDto })
  @ApiResponse({ status: 503, description: 'Contract not configured.' })
  getConfig(): SocialGraphConfigDto {
    return this.contractService.getConfig();
  }

  @Post('precheck')
  @HttpCode(204)
  @ApiOperation({
    operationId: 'precheckSocialGraphAction',
    summary:
      'Advisory precheck: would this follow/unfollow/block/unblock succeed on chain?',
  })
  @ApiResponse({ status: 204, description: 'Would succeed.' })
  @ApiResponse({ status: 400, description: 'Invalid action or address.' })
  @ApiResponse({
    status: 403,
    description: 'BLOCKED — the target has blocked the caller.',
  })
  @ApiResponse({
    status: 409,
    description:
      'Stale-state or cap: ALREADY_FOLLOWING, NOT_FOLLOWING, ALREADY_BLOCKED, ' +
      'NOT_BLOCKED, CANNOT_FOLLOW_SELF, CANNOT_BLOCK_SELF, BLOCKED_BY_SELF, ' +
      'MAX_FOLLOWING_REACHED, MAX_BLOCKED_REACHED.',
  })
  @ApiResponse({
    status: 429,
    description: 'FOLLOW_COOLDOWN (unreachable while follow_cooldown = 0).',
  })
  @ApiResponse({ status: 503, description: 'Contract not configured.' })
  async precheck(@Body() body: SocialGraphPrecheckDto): Promise<void> {
    const code = await this.socialGraphService.precheck(
      body.action,
      body.from,
      body.to,
    );
    if (!code) {
      return;
    }
    const status = SOCIAL_GRAPH_ABORT_STATUS[code];
    // The abort code reaches the client verbatim so it can render the mapped
    // Bucket A/B behaviour; nothing raw from the chain is ever re-thrown.
    throw new HttpException(
      { statusCode: status, error: code, message: code },
      status,
    );
  }

  private assertAddress(value: string, field: string): void {
    if (!value || !AE_ADDRESS_REGEX.test(value)) {
      throw new BadRequestException(`Invalid ${field} address`);
    }
  }
}
