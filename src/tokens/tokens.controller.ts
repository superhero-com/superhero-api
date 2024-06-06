import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Pagination, paginate } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { TokenDto } from './dto/token.dto';
import { Token } from './entities/token.entity';
import { ApiOkResponsePaginated } from './tmp/api-type';
import { TokensService } from './tokens.service';

@Controller('api/tokens')
@ApiTags('Tokens')
export class TokensController {
  constructor(
    @InjectRepository(Token)
    private readonly tokensRepository: Repository<Token>,
    private readonly tokensService: TokensService,
  ) {}

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: ['name', 'rank', 'price', 'market_cap'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({ operationId: 'listAll' })
  @ApiOkResponsePaginated(TokenDto)
  @Get()
  async listAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit = 10,
    @Query('order_by') orderBy: string = 'market_cap',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
  ): Promise<Pagination<Token>> {
    const queryBuilder = this.tokensRepository.createQueryBuilder('token');
    queryBuilder.orderBy(`token.${orderBy}`, orderDirection);
    return paginate<Token>(queryBuilder, { page, limit });
  }

  @ApiOperation({ operationId: 'findByAddress' })
  @Get(':address')
  @ApiResponse({
    type: TokenDto,
  })
  findByAddress(@Param('address') address: string) {
    return this.tokensService.findByAddress(address);
  }
}
