import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SocialGraphContractService } from './social-graph-contract.service';
import { SocialGraphService } from './social-graph.service';
import { SOCIAL_GRAPH_ABORT_STATUS } from './social-graph.errors';
import {
  AE_ADDRESS_REGEX,
  SocialGraphConfigDto,
  SocialGraphPrecheckDto,
  SocialGraphRelationshipDto,
} from './dto/social-graph.dto';

@ApiTags('Social Graph')
@Controller('social-graph')
export class SocialGraphController {
  constructor(
    private readonly socialGraphService: SocialGraphService,
    private readonly contractService: SocialGraphContractService,
  ) {}

  @Get('relationship')
  @ApiOperation({
    operationId: 'getSocialGraphRelationship',
    summary: 'Pair-wise follow/block relationship between two addresses',
  })
  @ApiQuery({ name: 'from', required: true, example: 'ak_...' })
  @ApiQuery({ name: 'to', required: true, example: 'ak_...' })
  @ApiResponse({ status: 200, type: SocialGraphRelationshipDto })
  @ApiResponse({ status: 400, description: 'Invalid address.' })
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
