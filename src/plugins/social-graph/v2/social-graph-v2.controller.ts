import {
  GraphV2CountsDto,
  GraphV2StatusDto,
  GraphV2ConnectionsDto,
  GraphV2RelationshipDto,
  GraphV2PolicyDto,
  GraphV2PageDto,
  GraphV2PrecheckDto,
} from './social-graph-v2.dto';
import { SocialGraphPrecheckDto } from '../dto/social-graph.dto';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ProfileReadService } from '@/profile/services/profile-read.service';
import { SocialGraphV2QueryService } from './social-graph-v2-query.service';
import {
  BadRequestException,
  Body,
  Post,
  HttpCode,
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

  @Get('status')
  @ApiOperation({
    operationId: 'getSocialGraphV2Status',
    summary: 'Projection progress and verified migration boundary evidence',
  })
  @ApiResponse({ status: 200, type: GraphV2StatusDto })
  async status() {
    const reader = this.graph.getReader();
    await reader.verifyIdentity();
    return this.queries.status(
      reader.identity.network,
      reader.identity.contract,
    );
  }

  @Get('counts')
  @ApiResponse({ status: 200, type: GraphV2CountsDto })
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
  @ApiResponse({ status: 200, type: GraphV2ConnectionsDto })
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
  @ApiResponse({ status: 200, type: GraphV2RelationshipDto })
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

  @Post('precheck')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'precheckSocialGraphV2Action',
    summary:
      'Read-only advisory simulation against real caller balance and current policy',
  })
  @ApiResponse({ status: 200, type: GraphV2PrecheckDto })
  @ApiResponse({
    status: 503,
    description: 'Simulation unavailable; never treat this as approval.',
  })
  precheck(@Body() body: SocialGraphPrecheckDto) {
    return this.graph.getReader().precheck(body.action, body.from, body.to);
  }

  @Get('policy')
  @ApiResponse({ status: 200, type: GraphV2PolicyDto })
  @ApiOperation({
    operationId: 'getSocialGraphV2Policy',
    summary: 'Fresh pinned policy, ownership and migration state',
  })
  policy() {
    return this.graph.getReader().policy();
  }

  @Get('page')
  @ApiResponse({ status: 200, type: GraphV2PageDto })
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
