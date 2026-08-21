import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
