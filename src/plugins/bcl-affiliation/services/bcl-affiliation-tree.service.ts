import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BclInvitationRegistered } from '../entities/bcl-invitation-registered.view';
import { BclInvitationRedeemed } from '../entities/bcl-invitation-redeemed.view';
import { BclInvitationRevoked } from '../entities/bcl-invitation-revoked.view';

export type BclAffiliationTreeAddressStats = {
  address: string;
  total_invitation_count: number; // registered as inviter
  total_claimed_invitation_count: number; // redeemed as inviter
  total_revoked_invitation_count: number; // revoked as inviter
  total_pending_invitation_count: number; // registered - redeemed - revoked as inviter
  total_amount_ae: number; // sum(amount) as inviter
  total_received_invitation_count: number; // registered as invitee
};

export type BclAffiliationTreeInviterNode = {
  sender_address: string;
  sender: BclAffiliationTreeAddressStats;
  invitees: Array<BclAffiliationTreeAddressStats>;
  amount: number; // total amount sent to invitees (AE)
};

@Injectable()
export class BclAffiliationTreeService {
  constructor(
    @InjectRepository(BclInvitationRegistered)
    private readonly registeredRepo: Repository<BclInvitationRegistered>,
    @InjectRepository(BclInvitationRedeemed)
    private readonly redeemedRepo: Repository<BclInvitationRedeemed>,
    @InjectRepository(BclInvitationRevoked)
    private readonly revokedRepo: Repository<BclInvitationRevoked>,
  ) {}

  async getTreeData(): Promise<{
    items: BclAffiliationTreeInviterNode[];
    meta: {
      unique_inviters: number;
      unique_invitees: number;
      total_registered: number;
      total_redeemed: number;
      total_revoked: number;
      total_amount_ae: number;
    };
  }> {
    const registered = await this.registeredRepo
      .createQueryBuilder('r')
      .select(['r.inviter AS inviter', 'r.invitee AS invitee', 'r.amount AS amount'])
      .where('r.inviter IS NOT NULL')
      .andWhere('r.invitee IS NOT NULL')
      .getRawMany<{ inviter: string; invitee: string; amount: string | null }>();

    // Counts per inviter/invitee
    const inviterRegisteredCount = new Map<string, number>();
    const inviterAmount = new Map<string, number>();
    const inviteeReceivedCount = new Map<string, number>();
    const inviterInvitees = new Map<string, Set<string>>();

    let total_amount_ae = 0;
    for (const row of registered) {
      const inviter = row.inviter;
      const invitee = row.invitee;
      const amount = Number(row.amount ?? 0) || 0;

      inviterRegisteredCount.set(inviter, (inviterRegisteredCount.get(inviter) ?? 0) + 1);
      inviterAmount.set(inviter, (inviterAmount.get(inviter) ?? 0) + amount);
      inviteeReceivedCount.set(invitee, (inviteeReceivedCount.get(invitee) ?? 0) + 1);
      total_amount_ae += amount;

      const set = inviterInvitees.get(inviter) ?? new Set<string>();
      set.add(invitee);
      inviterInvitees.set(inviter, set);
    }

    const [redeemedByInviter, revokedByInviter] = await Promise.all([
      this.redeemedRepo
        .createQueryBuilder('x')
        .select('x.inviter', 'inviter')
        .addSelect('COUNT(*)::int', 'count')
        .where('x.inviter IS NOT NULL')
        .groupBy('x.inviter')
        .getRawMany<{ inviter: string; count: number }>(),
      this.revokedRepo
        .createQueryBuilder('x')
        .select('x.inviter', 'inviter')
        .addSelect('COUNT(*)::int', 'count')
        .where('x.inviter IS NOT NULL')
        .groupBy('x.inviter')
        .getRawMany<{ inviter: string; count: number }>(),
    ]);

    const redeemedCount = new Map(
      redeemedByInviter.map((r) => [r.inviter, Number(r.count || 0)]),
    );
    const revokedCount = new Map(
      revokedByInviter.map((r) => [r.inviter, Number(r.count || 0)]),
    );

    const uniqueInviters = new Set(inviterRegisteredCount.keys());
    const uniqueInvitees = new Set(inviteeReceivedCount.keys());

    const items: BclAffiliationTreeInviterNode[] = [];

    for (const inviter of uniqueInviters) {
      const registered_count = inviterRegisteredCount.get(inviter) ?? 0;
      const redeemed_count = redeemedCount.get(inviter) ?? 0;
      const revoked_count = revokedCount.get(inviter) ?? 0;
      const pending_count = registered_count - redeemed_count - revoked_count;
      const amount = inviterAmount.get(inviter) ?? 0;

      const invitees = Array.from(inviterInvitees.get(inviter) ?? []).map((addr) => {
        return {
          address: addr,
          total_invitation_count: 0,
          total_claimed_invitation_count: 0,
          total_revoked_invitation_count: 0,
          total_pending_invitation_count: 0,
          total_amount_ae: 0,
          total_received_invitation_count: inviteeReceivedCount.get(addr) ?? 0,
        } satisfies BclAffiliationTreeAddressStats;
      });

      items.push({
        sender_address: inviter,
        sender: {
          address: inviter,
          total_invitation_count: registered_count,
          total_claimed_invitation_count: redeemed_count,
          total_revoked_invitation_count: revoked_count,
          total_pending_invitation_count: pending_count,
          total_amount_ae: amount,
          total_received_invitation_count: inviteeReceivedCount.get(inviter) ?? 0,
        },
        invitees,
        amount,
      });
    }

    return {
      items,
      meta: {
        unique_inviters: uniqueInviters.size,
        unique_invitees: uniqueInvitees.size,
        total_registered: registered.length,
        total_redeemed: redeemedByInviter.reduce((a, r) => a + Number(r.count || 0), 0),
        total_revoked: revokedByInviter.reduce((a, r) => a + Number(r.count || 0), 0),
        total_amount_ae,
      },
    };
  }
}


