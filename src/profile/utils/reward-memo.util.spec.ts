import {
  buildTx,
  decode,
  MemoryAccount,
  Tag,
  unpackTx,
} from '@aeternity/aepp-sdk';
import { rewardMemoPayload, rewardMemoText } from './reward-memo.util';

describe('reward payout memo', () => {
  it('names the program, and nothing that identifies the person', () => {
    expect(rewardMemoText('onboarding')).toBe('Superhero X reward: welcome');
    expect(rewardMemoText('per_post')).toBe('Superhero X reward: post');
    expect(rewardMemoText('streak_bonus', { streakDays: 10 })).toBe(
      'Superhero X reward: 10-day streak',
    );
    expect(rewardMemoText('invite_milestone', { invites: 10 })).toBe(
      'Superhero X reward: 10 invites',
    );
  });

  it('still says what it is when the detail is missing', () => {
    expect(rewardMemoText('streak_bonus')).toBe('Superhero X reward: streak');
    expect(rewardMemoText('invite_milestone')).toBe(
      'Superhero X reward: invites',
    );
  });

  it('never looks like a tip to the tipping indexers', () => {
    // TipService and the social-tipping plugin treat any SpendTx payload
    // starting with TIP_PROFILE / TIP_POST as a tip.
    for (const kind of [
      'onboarding',
      'per_post',
      'streak_bonus',
      'invite_milestone',
    ] as const) {
      const text = decode(rewardMemoPayload(kind)).toString();
      expect(text.startsWith('TIP_')).toBe(false);
    }
  });

  it('builds into a valid SpendTx that reads back as the same text', () => {
    // Offline: a real transaction built and unpacked by the SDK, so an encoding
    // mistake fails here instead of as a failed payout on-chain.
    const sender = MemoryAccount.generate().address;
    const recipient = MemoryAccount.generate().address;
    const payload = rewardMemoPayload('streak_bonus', { streakDays: 10 });

    const encodedTx = buildTx({
      tag: Tag.SpendTx,
      senderId: sender,
      recipientId: recipient,
      amount: '50000000000000000000',
      nonce: 1,
      payload,
    });
    // The SDK's unpacked union does not narrow on `tag`; these are the fields
    // this test reads.
    const tx = unpackTx(encodedTx) as unknown as {
      tag: Tag;
      payload: `ba_${string}`;
      recipientId: string;
      amount: string;
    };
    expect(tx.tag).toBe(Tag.SpendTx);

    expect(tx.payload).toBe(payload);
    expect(decode(tx.payload).toString()).toBe(
      'Superhero X reward: 10-day streak',
    );
    expect(tx.recipientId).toBe(recipient);
    expect(tx.amount).toBe('50000000000000000000');
  });
});
