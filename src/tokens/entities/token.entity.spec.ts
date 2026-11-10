import { getMetadataArgsStorage } from 'typeorm';
import { Token, UNRANKED_TOKEN_RANK } from './token.entity';

describe('Token entity', () => {
  it('does not map rank, which lives in token_rank', () => {
    // A mapped column would be selected with every token row and read as a
    // rank that RefreshTokenRanksService no longer updates.
    const rankColumn = getMetadataArgsStorage().columns.find(
      (column) => column.target === Token && column.propertyName === 'rank',
    );

    expect(rankColumn).toBeUndefined();
  });

  it('keeps the sentinel outside any realistic rank range', () => {
    expect(UNRANKED_TOKEN_RANK).toBe(2147483647);
    expect(UNRANKED_TOKEN_RANK).toBeGreaterThan(0);
  });
});
