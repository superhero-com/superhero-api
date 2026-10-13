import { UNRANKED_TOKEN_RANK } from '../entities/token.entity';
import { visibleTokenRank } from './token-rank.util';

describe('visibleTokenRank', () => {
  it('returns the persisted rank of a listed token', () => {
    expect(visibleTokenRank({ rank: 12, unlisted: false })).toBe(12);
  });

  it('hides the rank of an unlisted token', () => {
    expect(visibleTokenRank({ rank: 12, unlisted: true })).toBeUndefined();
  });

  it('hides the placeholder of a token the rank cron has not placed yet', () => {
    expect(
      visibleTokenRank({ rank: UNRANKED_TOKEN_RANK, unlisted: false }),
    ).toBeUndefined();
  });
});
