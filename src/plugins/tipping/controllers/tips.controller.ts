import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
  Param,
  NotFoundException,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { paginate } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { Tip } from '../entities/tip.entity';
import { Account } from '@/account/entities/account.entity';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { Post } from '@/plugins/social/entities/post.entity';

@Controller('tips')
@ApiTags('Tips')
export class TipsController {
  constructor(
    @InjectRepository(Tip)
    private readonly tipRepository: Repository<Tip>,

    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
  ) {
    //
  }

  // listTips: filter by sender, receiver, type; order by amount, type, created_at
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: ['amount', 'type', 'created_at'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiQuery({ name: 'sender', type: 'string', required: false })
  @ApiQuery({ name: 'receiver', type: 'string', required: false })
  @ApiQuery({ name: 'type', type: 'string', required: false })
  @ApiOperation({
    operationId: 'listTips',
    summary: 'List tips',
    description: 'Paginated tips with optional filters and ordering',
  })
  @ApiOkResponsePaginated(Tip)
  @Get()
  async listTips(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: 'amount' | 'type' | 'created_at' = 'created_at',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
    @Query('sender') sender?: string,
    @Query('receiver') receiver?: string,
    @Query('type') type?: string,
  ) {
    const query = this.tipRepository
      .createQueryBuilder('tip')
      .leftJoinAndMapOne(
        'tip.sender',
        Account,
        'sender',
        'sender.address = tip.sender_address',
      )
      .leftJoinAndMapOne(
        'tip.receiver',
        Account,
        'receiver',
        'receiver.address = tip.receiver_address',
      );

    if (sender) {
      query.andWhere('tip.sender_address = :sender', { sender });
    }
    if (receiver) {
      query.andWhere('tip.receiver_address = :receiver', { receiver });
    }
    if (type) {
      query.andWhere('tip.type = :type', { type });
    }

    // amount stored as string; order by numeric cast to preserve numeric ordering
    if (orderBy === 'amount') {
      query.orderBy('CAST(tip.amount AS numeric)', orderDirection);
    } else {
      query.orderBy(`tip.${orderBy}`, orderDirection);
    }
    // query.select('*');

    return paginate(query, { page, limit });
  }

  // getAccountSummary
  @ApiParam({ name: 'address', type: 'string', description: 'Account address' })
  @ApiOperation({
    operationId: 'getAccountSummary',
    summary: 'Account tips summary',
    description: 'Returns total tips sent and received for an account',
  })
  @Get('accounts/:address/summary')
  async getAccountSummary(@Param('address') address: string) {
    const totals = await this.tipRepository
      .createQueryBuilder('tip')
      .select(
        `COALESCE(SUM(CASE WHEN tip.sender_address = :address THEN CAST(tip.amount AS numeric) ELSE 0 END), 0) as total_sent`,
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN tip.receiver_address = :address THEN CAST(tip.amount AS numeric) ELSE 0 END), 0) as total_received`,
      )
      .setParameters({ address })
      .getRawOne<{ total_sent: string; total_received: string }>();

    return {
      totalTipsSent: totals?.total_sent ?? '0',
      totalTipsReceived: totals?.total_received ?? '0',
    };
  }

  // getPostSummary
  @ApiParam({ name: 'postId', type: 'string', description: 'Post ID' })
  @ApiOperation({
    operationId: 'getPostSummary',
    summary: 'Post tips summary',
    description: 'Returns total tips amount for a post',
  })
  @Get('posts/:postId/summary')
  async getPostSummary(@Param('postId') postId: string) {
    const post = await this.postRepository.findOne({
      where: { id: postId },
    });
    if (!post) {
      throw new NotFoundException(`Post with ID ${postId} not found`);
    }
    const postCreator = post.sender_address;
    const result = await this.tipRepository
      .createQueryBuilder('tip')
      .select('COALESCE(SUM(CAST(tip.amount AS numeric)), 0)', 'total')
      .where('tip.post_id = :postId', { postId })
      .andWhere('tip.sender_address != :postCreator', { postCreator })
      .getRawOne<{ total: string }>();

    return {
      totalTips: result?.total ?? '0',
    };
  }
}
