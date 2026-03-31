import { isSelfTip } from './is-self-tip.util';

describe('isSelfTip', () => {
  it('returns true when post tip sender is the post author', () => {
    expect(isSelfTip('ak_1', 'ak_2', { sender_address: 'ak_1' } as any)).toBe(
      true,
    );
  });

  it('returns false when post tip sender is not the post author', () => {
    expect(isSelfTip('ak_1', 'ak_2', { sender_address: 'ak_3' } as any)).toBe(
      false,
    );
  });

  it('returns true for profile self-tip when sender equals receiver', () => {
    expect(isSelfTip('ak_1', 'ak_1', null)).toBe(true);
  });

  it('returns false for profile tip when sender differs from receiver', () => {
    expect(isSelfTip('ak_1', 'ak_2', null)).toBe(false);
  });
});
