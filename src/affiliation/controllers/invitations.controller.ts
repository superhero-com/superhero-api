import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { paginate } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { Invitation } from '../entities/invitation.entity';
import { Account } from '@/account/entities/account.entity';

@Controller('invitations')
@ApiTags('Invitations')
export class InvitationsController {
  constructor(
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
  ) {
    //
  }

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: ['amount', 'created_at'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({ operationId: 'listAll' })
  @Get()
  async listAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'amount',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
  ) {
    const query = this.invitationRepository.createQueryBuilder('invitation');
    if (orderBy) {
      query.orderBy(`invitation.${orderBy}`, orderDirection);
    }
    // left join account and map as nested account object
    query.leftJoinAndMapOne(
      'invitation.account',
      Account,
      'account',
      'account.address = invitation.invitee_address',
    );
    return paginate(query, { page, limit });
  }
}
