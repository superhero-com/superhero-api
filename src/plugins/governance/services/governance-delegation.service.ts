import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    IPaginationOptions,
    paginate,
    Pagination,
} from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import {
    GovernanceDelegationHistoryItemDto,
    GovernanceDelegationWithRevokedDto
} from '../dto/governance-delegation.dto';
import { GovernanceDelegation } from '../entities/governance-delegation.view';
import { GovernanceRevokedDelegation } from '../entities/governance-revoked-delegation.view';

@Injectable()
export class GovernanceDelegationService {
  constructor(
    @InjectRepository(GovernanceDelegation)
    private readonly delegationRepository: Repository<GovernanceDelegation>,
    @InjectRepository(GovernanceRevokedDelegation)
    private readonly revokedDelegationRepository: Repository<GovernanceRevokedDelegation>,
  ) {}

  async findAll(
    options: IPaginationOptions,
    includeRevoked: boolean = false,
  ): Promise<Pagination<GovernanceDelegationWithRevokedDto>> {
    const query = this.delegationRepository
      .createQueryBuilder('delegation')
      .orderBy('delegation.created_at', 'DESC');

    const paginatedResult = await paginate(query, options);

    // Get all revoked delegations for efficient lookup
    const revokedDelegations = await this.revokedDelegationRepository.find({
      order: { created_at: 'ASC' },
    });

    // Map delegations and attach revocation info
    const items: GovernanceDelegationWithRevokedDto[] = paginatedResult.items
      .map((delegation): GovernanceDelegationWithRevokedDto | null => {
        // Find if there's a revocation for this delegator after this delegation
        const revocation = delegation.delegator
          ? revokedDelegations.find(
              (r) =>
                r.delegator === delegation.delegator &&
                (r.block_height > delegation.block_height ||
                  (r.block_height === delegation.block_height &&
                    r.micro_time > delegation.micro_time)),
            )
          : null;

        const isRevoked = !!revocation;

        if (!includeRevoked && isRevoked) {
          return null;
        }

        return {
          ...delegation,
          revoked: isRevoked || false,
          revoked_hash: isRevoked ? revocation!.hash : undefined,
          revoked_block_height: isRevoked
            ? revocation!.block_height
            : undefined,
          revoked_at: isRevoked ? revocation!.created_at : undefined,
        } as GovernanceDelegationWithRevokedDto;
      })
      .filter((item): item is GovernanceDelegationWithRevokedDto => item !== null);

    // If we filtered out revoked items, update itemCount in metadata
    // Note: totalItems and totalPages reflect all delegations, not filtered ones
    // This is acceptable since the user can use includeRevoked=true to see all
    return {
      ...paginatedResult,
      items,
      meta: {
        ...paginatedResult.meta,
        itemCount: items.length,
      },
    };
  }

  async findHistoryByAccount(
    accountAddress: string,
  ): Promise<GovernanceDelegationHistoryItemDto[]> {
    // Get all delegations where account is delegator or delegatee
    const delegations = await this.delegationRepository.find({
      where: [
        { delegator: accountAddress },
        { delegatee: accountAddress },
      ],
      order: { created_at: 'ASC' },
    });

    // Get all revocations where account is delegator
    const revocations = await this.revokedDelegationRepository.find({
      where: { delegator: accountAddress },
      order: { created_at: 'ASC' },
    });

    // Combine and sort by created_at
    const history: GovernanceDelegationHistoryItemDto[] = [
      ...delegations.map((d) => ({
        hash: d.hash,
        block_hash: d.block_hash,
        block_height: d.block_height,
        caller_id: d.caller_id,
        function: d.function,
        created_at: d.created_at,
        micro_time: d.micro_time,
        data: d.data,
        _version: d._version,
        delegator: d.delegator,
        delegatee: d.delegatee,
      })),
      ...revocations.map((r) => ({
        hash: r.hash,
        block_hash: r.block_hash,
        block_height: r.block_height,
        caller_id: r.caller_id,
        function: r.function,
        created_at: r.created_at,
        micro_time: r.micro_time,
        data: r.data,
        _version: r._version,
        delegator: r.delegator,
        delegatee: undefined,
      })),
    ].sort((a, b) => {
      if (a.created_at < b.created_at) return -1;
      if (a.created_at > b.created_at) return 1;
      // If same timestamp, use micro_time
      if (a.micro_time < b.micro_time) return -1;
      if (a.micro_time > b.micro_time) return 1;
      return 0;
    });

    return history;
  }
}

