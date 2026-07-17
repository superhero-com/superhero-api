import { getMetadataArgsStorage } from 'typeorm';
import { Token, UNRANKED_TOKEN_RANK } from './token.entity';

describe('Token entity', () => {
  it('defaults rank to the unranked sentinel, not 0', () => {
    // Guards the exact regression this constant fixes: `rank` sorts ASC
    // (1 = highest market cap) in queryTokensWithRanks, so a default of 0
    // would put every newly-created token ahead of the real #1 token until
    // the next RefreshTokenRanksService tick.
    const rankColumn = getMetadataArgsStorage().columns.find(
      (column) => column.target === Token && column.propertyName === 'rank',
    );

    expect(rankColumn).toBeDefined();
    expect(rankColumn!.options.default).toBe(UNRANKED_TOKEN_RANK);
    expect(rankColumn!.options.default).not.toBe(0);
  });

  it('keeps the sentinel outside any realistic rank range', () => {
    expect(UNRANKED_TOKEN_RANK).toBe(2147483647);
    expect(UNRANKED_TOKEN_RANK).toBeGreaterThan(0);
  });
});
