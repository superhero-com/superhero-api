import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Account } from '@/account/entities/account.entity';
import { ProfileCache } from '@/profile/entities/profile-cache.entity';
import { SocialGraphEdge } from './entities/social-graph-edge.entity';
import { SocialGraphContractService } from './social-graph-contract.service';
import { SocialGraphAbortCode } from './social-graph.errors';
import {
  SocialGraphAction,
  SocialGraphRelationshipDto,
} from './dto/social-graph.dto';

// `null` means the action would succeed, otherwise the abort code the contract
// would raise first.
export type SocialGraphPrecheckResult = SocialGraphAbortCode | null;

// Read side of the social graph: counts and relationship served from the index,
// and an advisory precheck derived from the index plus the boot-verified caps.
@Injectable()
export class SocialGraphService {
  constructor(
    @InjectRepository(SocialGraphEdge)
    private readonly edgeRepo: Repository<SocialGraphEdge>,
    private readonly contractService: SocialGraphContractService,
  ) {}

  getFollowingCount(address: string): Promise<number> {
    return this.edgeRepo.count({
      where: { from_address: address, kind: 'follow' },
    });
  }

  getFollowersCount(address: string): Promise<number> {
    return this.edgeRepo.count({
      where: { to_address: address, kind: 'follow' },
    });
  }

  getBlockedCount(address: string): Promise<number> {
    return this.edgeRepo.count({
      where: { from_address: address, kind: 'block' },
    });
  }

  // One page of an account's followers or following list. `followers` walks the
  // edges pointing AT `address` (each `from_address` is a follower); `following`
  // walks the edges FROM it (each `to_address` is someone it follows). Keyset
  // paginated on the edge id (descending, most-recently-indexed first): stable
  // under concurrent inserts and index-only, so scroll-down "load more" never
  // re-reads or skips a row the way OFFSET does. `search` filters the
  // counterparty by address, chain name, or cached profile name. Returns the
  // ordered counterparty addresses plus the cursor to pass back, or `null` when
  // the page is the last.
  async listConnections(params: {
    address: string;
    direction: 'followers' | 'following';
    search?: string;
    cursor?: number;
    limit: number;
  }): Promise<{ addresses: string[]; nextCursor: number | null }> {
    const { address, direction, search, cursor, limit } = params;
    const ownerColumn =
      direction === 'followers' ? 'to_address' : 'from_address';
    const otherColumn =
      direction === 'followers' ? 'from_address' : 'to_address';

    const query = this.edgeRepo
      .createQueryBuilder('edge')
      .select('edge.id', 'id')
      .addSelect(`edge.${otherColumn}`, 'address')
      .where(`edge.${ownerColumn} = :address`, { address })
      .andWhere('edge.kind = :kind', { kind: 'follow' });

    const trimmedSearch = search?.trim();
    if (trimmedSearch) {
      const like = `%${trimmedSearch}%`;
      query
        .leftJoin(Account, 'account', `account.address = edge.${otherColumn}`)
        .leftJoin(
          ProfileCache,
          'profile_cache',
          `profile_cache.address = edge.${otherColumn}`,
        )
        .andWhere(
          new Brackets((qb) => {
            qb.where(`edge.${otherColumn} ILIKE :like`, { like })
              .orWhere('account.chain_name ILIKE :like', { like })
              .orWhere('profile_cache.public_name ILIKE :like', { like })
              .orWhere('profile_cache.username ILIKE :like', { like })
              .orWhere('profile_cache.fullname ILIKE :like', { like });
          }),
        );
    }

    if (cursor !== undefined) {
      query.andWhere('edge.id < :cursor', { cursor });
    }

    // Peek one past the page: an extra row means there is a next page, and its
    // predecessor's id is the cursor.
    const rows = await query
      .orderBy('edge.id', 'DESC')
      .limit(limit + 1)
      .getRawMany<{ id: number; address: string }>();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? Number(page[page.length - 1].id) : null;

    return { addresses: page.map((row) => row.address), nextCursor };
  }

  private async edgeExists(
    from: string,
    to: string,
    kind: 'follow' | 'block',
  ): Promise<boolean> {
    const count = await this.edgeRepo.count({
      where: { from_address: from, to_address: to, kind },
    });
    return count > 0;
  }

  async getRelationship(
    from: string,
    to: string,
  ): Promise<SocialGraphRelationshipDto> {
    const [aFollowsB, bFollowsA, aBlockedB, bBlockedA] = await Promise.all([
      this.edgeExists(from, to, 'follow'),
      this.edgeExists(to, from, 'follow'),
      this.edgeExists(from, to, 'block'),
      this.edgeExists(to, from, 'block'),
    ]);
    return {
      a_follows_b: aFollowsB,
      b_follows_a: bFollowsA,
      a_blocked_b: aBlockedB,
      b_blocked_a: bBlockedA,
    };
  }

  // Check order mirrors the contract's require() order so the returned code
  // matches what the chain would abort with first. FOLLOW_COOLDOWN is not
  // index-derivable (needs the caller's last_follow_height) and is unreachable
  // at follow_cooldown=0, so the precheck never emits it.
  async precheck(
    action: SocialGraphAction,
    from: string,
    to: string,
  ): Promise<SocialGraphPrecheckResult> {
    switch (action) {
      case 'follow':
        return this.precheckFollow(from, to);
      case 'unfollow':
        return (await this.edgeExists(from, to, 'follow'))
          ? null
          : 'NOT_FOLLOWING';
      case 'block':
        return this.precheckBlock(from, to);
      case 'unblock':
        return (await this.edgeExists(from, to, 'block'))
          ? null
          : 'NOT_BLOCKED';
    }
  }

  private async precheckFollow(
    from: string,
    to: string,
  ): Promise<SocialGraphPrecheckResult> {
    if (from === to) {
      return 'CANNOT_FOLLOW_SELF';
    }
    if (await this.edgeExists(to, from, 'block')) {
      return 'BLOCKED';
    }
    if (await this.edgeExists(from, to, 'block')) {
      return 'BLOCKED_BY_SELF';
    }
    if (await this.edgeExists(from, to, 'follow')) {
      return 'ALREADY_FOLLOWING';
    }
    const followingCount = await this.getFollowingCount(from);
    if (followingCount >= this.contractService.getConfig().max_following) {
      return 'MAX_FOLLOWING_REACHED';
    }
    return null;
  }

  private async precheckBlock(
    from: string,
    to: string,
  ): Promise<SocialGraphPrecheckResult> {
    if (from === to) {
      return 'CANNOT_BLOCK_SELF';
    }
    if (await this.edgeExists(from, to, 'block')) {
      return 'ALREADY_BLOCKED';
    }
    const blockedCount = await this.getBlockedCount(from);
    if (blockedCount >= this.contractService.getConfig().max_blocked) {
      return 'MAX_BLOCKED_REACHED';
    }
    return null;
  }
}
