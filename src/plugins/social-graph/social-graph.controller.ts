import {
  GraphCountsDto,
  GraphStatusDto,
  GraphConnectionsDto,
  GraphRelationshipDto,
  GraphPolicyDto,
  GraphPageDto,
} from './social-graph.dto';
import {
  SocialGraphPrecheckDto,
  SocialGraphConfigDto,
  SocialGraphConnectionsPageDto,
} from './dto/social-graph.dto';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ProfileReadService } from '@/profile/services/profile-read.service';
import { SocialGraphQueryService } from './social-graph-query.service';
import {
  BadRequestException,
  Body,
  Post,
  HttpCode,
  HttpException,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { SocialGraphService } from './social-graph.service';
import { GraphDirection } from './social-graph-reader';

@ApiTags('Social Graph')
@Controller('social-graph')
export class SocialGraphController {
  constructor(
    private readonly graph: SocialGraphService,
    private readonly queries: SocialGraphQueryService,
    private readonly profiles: ProfileReadService,
  ) {}

  @Get('followers')
  @ApiOperation({
    operationId: 'listSocialGraphFollowers',
    summary:
      'Bounded follower page; continue with the cursor even when search returns no matches.',
  })
  @ApiQuery({ name: 'address', required: true })
  @ApiQuery({
    name: 'search',
    required: false,
    description:
      'Filter the bounded page by address, chain name or profile name.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description:
      'Opaque continuation; an empty page may still have a next cursor.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: '1–100 slots, default 20.',
  })
  @ApiResponse({ status: 200, type: SocialGraphConnectionsPageDto })
  async followers(
    @Query('address') address: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    const page = await this.connections(
      address,
      'followers',
      limit,
      cursor,
      search,
    );
    return { items: page.items, next_cursor: page.next_cursor };
  }

  @Get('following')
  @ApiOperation({
    operationId: 'listSocialGraphFollowing',
    summary:
      'Bounded following page; continue with the cursor even when search returns no matches.',
  })
  @ApiQuery({ name: 'address', required: true })
  @ApiQuery({
    name: 'search',
    required: false,
    description:
      'Filter the bounded page by address, chain name or profile name.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description:
      'Opaque continuation; an empty page may still have a next cursor.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: '1–100 slots, default 20.',
  })
  @ApiResponse({ status: 200, type: SocialGraphConnectionsPageDto })
  async following(
    @Query('address') address: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    const page = await this.connections(
      address,
      'following',
      limit,
      cursor,
      search,
    );
    return { items: page.items, next_cursor: page.next_cursor };
  }

  @Get('config')
  @ApiOperation({
    operationId: 'getSocialGraphConfig',
    summary: 'Current contract caps and address.',
  })
  @ApiResponse({ status: 200, type: SocialGraphConfigDto })
  config() {
    return this.graph.getConfig();
  }

  @Get('status')
  @ApiOperation({
    operationId: 'getSocialGraphStatus',
    summary: 'Projection progress and verified migration boundary evidence',
  })
  @ApiResponse({ status: 200, type: GraphStatusDto })
  async status() {
    const reader = this.graph.getReader();
    await reader.verifyIdentity();
    return this.queries.status(
      reader.identity.network,
      reader.identity.contract,
    );
  }

  @Get('counts')
  @ApiResponse({ status: 200, type: GraphCountsDto })
  @ApiOperation({
    operationId: 'getSocialGraphCounts',
    summary: 'Scoped indexed counts as decimal strings',
  })
  @ApiQuery({ name: 'account', required: true })
  async counts(@Query('account') account: string) {
    const reader = this.graph.getReader();
    await reader.verifyIdentity();
    const { network, contract } = reader.identity;
    return this.queries.counts(
      await this.queries.ready(network, contract),
      account,
    );
  }

  @Get('connections')
  @ApiResponse({ status: 200, type: GraphConnectionsDto })
  @ApiOperation({
    operationId: 'listSocialGraphConnections',
    summary: 'Scoped keyset page with batched profiles',
  })
  @ApiQuery({ name: 'account', required: true })
  @ApiQuery({ name: 'direction', enum: ['followers', 'following'] })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'search', required: false })
  async connections(
    @Query('account') account: string,
    @Query('direction') direction: 'followers' | 'following',
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
    @Query('cursor') cursor?: string,
    @Query('search') search?: string,
  ) {
    const reader = this.graph.getReader();
    await reader.verifyIdentity();
    const { network, contract } = reader.identity;
    const page = await this.queries.connections(
      await this.queries.ready(network, contract),
      account,
      direction,
      limit,
      cursor,
      search,
    );
    const profiles = await this.profiles.getProfilesByAddresses(page.addresses);
    const byAddress = new Map(
      profiles.map((profile) => [profile.address, profile]),
    );
    return {
      ...page,
      items: page.addresses.map(
        (address) =>
          byAddress.get(address) ?? {
            address,
            public_name: address,
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
          },
      ),
    };
  }

  @Get('relationship')
  @ApiResponse({ status: 200, type: GraphRelationshipDto })
  @ApiOperation({
    operationId: 'getSocialGraphRelationship',
    summary:
      'Pinned relationship and lifecycle; advisory, never transaction authorization',
  })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  relationship(@Query('from') from: string, @Query('to') to: string) {
    return this.graph.getReader().relationship(from, to);
  }

  @Post('precheck')
  @HttpCode(204)
  @ApiOperation({
    operationId: 'precheckSocialGraphAction',
    summary:
      'Read-only advisory simulation against real caller balance and current policy',
  })
  @ApiResponse({ status: 204, description: 'Advisory simulation passed.' })
  @ApiResponse({ status: 409, description: 'Contract rejected the action.' })
  @ApiResponse({
    status: 503,
    description: 'Simulation unavailable; never treat this as approval.',
  })
  async precheck(@Body() body: SocialGraphPrecheckDto): Promise<void> {
    const result = await this.graph
      .getReader()
      .precheck(body.action, body.from, body.to);
    if (result.reason) {
      const status = result.suggested_http_status ?? 503;
      throw new HttpException(
        { statusCode: status, error: result.reason, message: result.reason },
        status,
      );
    }
  }

  @Get('policy')
  @ApiResponse({ status: 200, type: GraphPolicyDto })
  @ApiOperation({
    operationId: 'getSocialGraphPolicy',
    summary: 'Fresh pinned policy, ownership and migration state',
  })
  policy() {
    return this.graph.getReader().policy('top');
  }

  @Get('page')
  @ApiResponse({ status: 200, type: GraphPageDto })
  @ApiOperation({
    operationId: 'getSocialGraphChainPage',
    summary:
      'Bounded snapshot-pinned contract slots; empty page can have continuation',
  })
  @ApiQuery({
    name: 'direction',
    enum: ['followers', 'following', 'blocked', 'export'],
  })
  @ApiQuery({ name: 'account', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  page(
    @Query('direction') direction: GraphDirection,
    @Query('account') account = '',
    @Query('cursor') cursor?: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ) {
    if (!['followers', 'following', 'blocked', 'export'].includes(direction))
      throw new BadRequestException('Invalid direction');
    return this.graph.getReader().page(direction, account, limit, cursor);
  }
}
