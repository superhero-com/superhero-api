import { InvitationClaimedNotification } from './invitation-claimed.notification';

describe('InvitationClaimedNotification', () => {
  const base = {
    inviter: 'ak_inviter',
    claimer: 'ak_2claimeraddressthatislong000000000000000000000',
    amountAe: '5',
    txHash: 'th_claim',
  };

  it('routes through the expo channel', () => {
    const n = new InvitationClaimedNotification(base);
    expect(n.via()).toEqual(['expo']);
    expect(n.type).toBe('invitation-claimed');
  });

  it('exposes catalog META mirrored onto the instance', () => {
    expect(InvitationClaimedNotification.META.type).toBe('invitation-claimed');
    const n = new InvitationClaimedNotification(base);
    expect(n.title).toBe(InvitationClaimedNotification.META.title);
    expect(n.description).toBe(InvitationClaimedNotification.META.description);
  });

  it('builds a stable per-(tx,recipient) dedup key', () => {
    const n = new InvitationClaimedNotification(base);
    expect(n.dedupKey({ address: 'ak_inviter' as any })).toBe(
      'th_claim:ak_inviter',
    );
  });

  it('renders the expo message with claimer label and amount', () => {
    const n = new InvitationClaimedNotification({
      ...base,
      claimerLabel: 'bob.chain',
    });
    const msg = n.toExpo();
    expect(msg.title).toBe('Invitation claimed');
    expect(msg.body).toBe('bob.chain just claimed your invitation for 5 AE');
    expect(msg.data).toMatchObject({
      type: 'invitation-claimed',
      txHash: 'th_claim',
      claimer: base.claimer,
    });
  });

  it('falls back to a shortened address when no label is given', () => {
    const n = new InvitationClaimedNotification(base);
    expect(n.toExpo().body).toContain('ak_2clai...0000');
  });
});
