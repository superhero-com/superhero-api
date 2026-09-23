import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ProfileReadService } from '@/profile/services/profile-read.service';
import { SocialGraphV2QueryService } from './social-graph-v2-query.service';
import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { SocialGraphV2Service } from './social-graph-v2.service';
import { GraphDirection } from './social-graph-v2-reader';

@ApiTags('Social Graph V2')
@Controller('social-graph/v2')
export class SocialGraphV2Controller {
  constructor(
    private readonly graph: SocialGraphV2Service,
    private readonly queries: SocialGraphV2QueryService,
    private readonly profiles: ProfileReadService,
  ) {}

  @Get('counts')
  @ApiOperation({
    operationId: 'getSocialGraphV2Counts',
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
  @ApiOperation({
    operationId: 'listSocialGraphV2Connections',
    summary: 'Scoped keyset page with batched profiles',
  })
  @ApiQuery({ name: 'account', required: true })
  @ApiQuery({ name: 'direction', enum: ['followers', 'following'] })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false })
  async connections(
    @Query('account') account: string,
    @Query('direction') direction: 'followers' | 'following',
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
    @Query('cursor') cursor?: string,
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
    );
    const profiles = await this.profiles.getProfilesByAddresses(page.addresses);
    const byAddress = new Map(
      profiles.map((profile) => [profile.address, profile]),
    );
    return {
      ...page,
      items: page.addresses.map(
        (address) => byAddress.get(address) ?? { address },
      ),
    };
  }

  @Get('relationship')
  @ApiOperation({
    operationId: 'getSocialGraphV2Relationship',
    summary:
      'Pinned relationship and lifecycle; advisory, never transaction authorization',
  })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  relationship(@Query('from') from: string, @Query('to') to: string) {
    return this.graph.getReader().relationship(from, to);
  }

  @Get('policy')
  @ApiOperation({
    operationId: 'getSocialGraphV2Policy',
    summary: 'Fresh pinned policy, ownership and migration state',
  })
  policy() {
    return this.graph.getReader().policy();
  }

  @Get('page')
  @ApiOperation({
    operationId: 'getSocialGraphV2ChainPage',
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
