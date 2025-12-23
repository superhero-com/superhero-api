import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { Pagination } from 'nestjs-typeorm-paginate';
import { BclAffiliationInvitationsService } from '../services/bcl-affiliation-invitations.service';
import { BclInvitationRegistered } from '../entities/bcl-invitation-registered.view';
import { BclInvitationRedeemed } from '../entities/bcl-invitation-redeemed.view';
import { BclInvitationRevoked } from '../entities/bcl-invitation-revoked.view';

@Controller('bcl-affiliation/invitations')
@ApiTags('BCL-Affiliation')
export class BclAffiliationInvitationsController {
  constructor(
    private readonly bclAffiliationInvitationsService: BclAffiliationInvitationsService,
  ) {}

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'inviter', type: 'string', required: false })
  @ApiQuery({ name: 'invitee', type: 'string', required: false })
  @ApiQuery({ name: 'contract', type: 'string', required: false })
  @ApiOperation({
    operationId: 'listBclInvitationRegistered',
    summary: 'List InvitationRegistered events (one row per invitation)',
  })
  @ApiOkResponsePaginated(BclInvitationRegistered)
  @Get('registered')
  async listRegistered(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('inviter') inviter?: string,
    @Query('invitee') invitee?: string,
    @Query('contract') contract?: string,
  ): Promise<Pagination<BclInvitationRegistered> & { queryMs: number }> {
    return this.bclAffiliationInvitationsService.findRegistered(
      { page, limit },
      { inviter, invitee, contract },
    );
  }

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'inviter', type: 'string', required: false })
  @ApiQuery({ name: 'invitee', type: 'string', required: false })
  @ApiQuery({ name: 'redeemer', type: 'string', required: false })
  @ApiQuery({ name: 'contract', type: 'string', required: false })
  @ApiOperation({
    operationId: 'listBclInvitationRedeemed',
    summary: 'List InvitationRedeemed events (one row per invitation)',
  })
  @ApiOkResponsePaginated(BclInvitationRedeemed)
  @Get('redeemed')
  async listRedeemed(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('inviter') inviter?: string,
    @Query('invitee') invitee?: string,
    @Query('redeemer') redeemer?: string,
    @Query('contract') contract?: string,
  ): Promise<Pagination<BclInvitationRedeemed> & { queryMs: number }> {
    return this.bclAffiliationInvitationsService.findRedeemed(
      { page, limit },
      { inviter, invitee, redeemer, contract },
    );
  }

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'inviter', type: 'string', required: false })
  @ApiQuery({ name: 'invitee', type: 'string', required: false })
  @ApiQuery({ name: 'contract', type: 'string', required: false })
  @ApiOperation({
    operationId: 'listBclInvitationRevoked',
    summary: 'List InvitationRevoked events (one row per invitation)',
  })
  @ApiOkResponsePaginated(BclInvitationRevoked)
  @Get('revoked')
  async listRevoked(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('inviter') inviter?: string,
    @Query('invitee') invitee?: string,
    @Query('contract') contract?: string,
  ): Promise<Pagination<BclInvitationRevoked> & { queryMs: number }> {
    return this.bclAffiliationInvitationsService.findRevoked(
      { page, limit },
      { inviter, invitee, contract },
    );
  }
}


