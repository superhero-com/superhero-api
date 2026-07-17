import {
  BadRequestException,
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
import { OptionalAeAccountAddressPipe } from '@/common/validation/request-validation';

const ALLOWED_ORDER_BY = new Set(['amount', 'created_at']);
const ALLOWED_ORDER_DIRECTIONS = new Set(['ASC', 'DESC']);

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
  @ApiQuery({
    name: 'inviter',
    type: 'string',
    required: false,
    description:
      'Filter to invitations sent by this address; each item includes its ' +
      'claim status (claimed, claimer_address, claimed_at, claim_tx_hash) ' +
      'so callers no longer need a per-invitee middleware lookup.',
  })
  @ApiOperation({ operationId: 'listAll' })
  @Get()
  async listAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'amount',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
    @Query('inviter', OptionalAeAccountAddressPipe) inviter?: string,
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
    const query = this.invitationRepository.createQueryBuilder('invitation');
    if (orderBy) {
      query.orderBy(`invitation.${orderBy}`, orderDirection);
    }
    if (inviter) {
      query.andWhere('invitation.sender_address = :inviter', { inviter });
    }
    // left join account and map as nested account object
    query.leftJoinAndMapOne(
      'invitation.invitee',
      Account,
      'invitee',
      'invitee.address = invitation.invitee_address',
    );
    // sender_address leftjoinandmapone account
    query.leftJoinAndMapOne(
      'invitation.sender',
      Account,
      'sender',
      'sender.address = invitation.sender_address',
    );
    const result = await paginate(query, { page, limit });

    return {
      ...result,
      items: result.items.map((invitation) => ({
        ...invitation,
        claimed: invitation.status === 'claimed',
        claimer_address: invitation.invitee_address ?? null,
        claimed_at:
          invitation.status === 'claimed'
            ? invitation.status_updated_at
            : null,
        claim_tx_hash: invitation.claim_tx_hash ?? null,
      })),
    };
  }
}
