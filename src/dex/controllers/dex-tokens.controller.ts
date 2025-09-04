import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiOkResponse,
} from '@nestjs/swagger';
import { DexTokenService } from '../services/dex-token.service';
import { DexTokenDto } from '../dto';
import { ApiOkResponsePaginated } from '@/utils/api-type';

@Controller('dex/tokens')
@ApiTags('DEX')
export class DexTokensController {
  constructor(private readonly dexTokenService: DexTokenService) {}

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: ['pairs_count', 'name', 'symbol', 'created_at'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({
    operationId: 'listAllDexTokens',
    summary: 'Get all DEX tokens',
    description:
      'Retrieve a paginated list of all DEX tokens with optional sorting',
  })
  @ApiOkResponsePaginated(DexTokenDto)
  @Get()
  async listAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'created_at',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
  ) {
    return this.dexTokenService.findAll(
      { page, limit },
      orderBy,
      orderDirection,
    );
  }

  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token contract address',
  })
  @ApiOperation({
    operationId: 'getDexTokenByAddress',
    summary: 'Get DEX token by address',
    description: 'Retrieve a specific DEX token by its contract address',
  })
  @ApiOkResponse({ type: DexTokenDto })
  @Get(':address')
  async getByAddress(@Param('address') address: string) {
    const token = await this.dexTokenService.findByAddress(address);
    if (!token) {
      throw new NotFoundException(
        `DEX token with address ${address} not found`,
      );
    }
    return token;
  }
}
