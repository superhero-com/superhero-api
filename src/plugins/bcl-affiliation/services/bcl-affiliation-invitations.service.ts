import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { BclInvitationRegistered } from '../entities/bcl-invitation-registered.view';
import { BclInvitationRedeemed } from '../entities/bcl-invitation-redeemed.view';
import { BclInvitationRevoked } from '../entities/bcl-invitation-revoked.view';
import { SelectQueryBuilder } from 'typeorm';

@Injectable()
export class BclAffiliationInvitationsService {
  constructor(
    @InjectRepository(BclInvitationRegistered)
    private readonly registeredRepository: Repository<BclInvitationRegistered>,
    @InjectRepository(BclInvitationRedeemed)
    private readonly redeemedRepository: Repository<BclInvitationRedeemed>,
    @InjectRepository(BclInvitationRevoked)
    private readonly revokedRepository: Repository<BclInvitationRevoked>,
  ) {}

  async findRegistered(
    options: IPaginationOptions,
    filters?: { inviter?: string; invitee?: string; contract?: string },
  ): Promise<Pagination<BclInvitationRegistered> & { queryMs: number }> {
    const query = this.registeredRepository
      .createQueryBuilder('inv')
      .orderBy('inv.block_height', 'DESC')
      .addOrderBy('inv.micro_time', 'DESC')
      .addOrderBy('inv.invitation_index', 'DESC');

    this.applyCommonFilters(query, filters);

    const start = Date.now();
    const res = await paginate<BclInvitationRegistered>(query, options);
    const queryMs = Date.now() - start;

    return { ...res, queryMs };
  }

  async findRedeemed(
    options: IPaginationOptions,
    filters?: {
      inviter?: string;
      invitee?: string;
      redeemer?: string;
      contract?: string;
    },
  ): Promise<Pagination<BclInvitationRedeemed> & { queryMs: number }> {
    const query = this.redeemedRepository
      .createQueryBuilder('inv')
      .orderBy('inv.block_height', 'DESC')
      .addOrderBy('inv.micro_time', 'DESC')
      .addOrderBy('inv.invitation_index', 'DESC');

    this.applyCommonFilters(query, filters);
    if (filters?.redeemer) {
      query.andWhere('inv.redeemer = :redeemer', { redeemer: filters.redeemer });
    }

    const start = Date.now();
    const res = await paginate<BclInvitationRedeemed>(query, options);
    const queryMs = Date.now() - start;

    return { ...res, queryMs };
  }

  async findRevoked(
    options: IPaginationOptions,
    filters?: { inviter?: string; invitee?: string; contract?: string },
  ): Promise<Pagination<BclInvitationRevoked> & { queryMs: number }> {
    const query = this.revokedRepository
      .createQueryBuilder('inv')
      .orderBy('inv.block_height', 'DESC')
      .addOrderBy('inv.micro_time', 'DESC')
      .addOrderBy('inv.invitation_index', 'DESC');

    this.applyCommonFilters(query, filters);

    const start = Date.now();
    const res = await paginate<BclInvitationRevoked>(query, options);
    const queryMs = Date.now() - start;

    return { ...res, queryMs };
  }

  private applyCommonFilters(
    query: SelectQueryBuilder<any>,
    filters?: { inviter?: string; invitee?: string; contract?: string },
  ) {
    if (!filters) return;
    if (filters.contract) {
      query.andWhere('inv.contract = :contract', { contract: filters.contract });
    }
    if (filters.inviter) {
      query.andWhere('inv.inviter = :inviter', { inviter: filters.inviter });
    }
    if (filters.invitee) {
      query.andWhere('inv.invitee = :invitee', { invitee: filters.invitee });
    }
  }
}


