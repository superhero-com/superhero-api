import { Token, UNRANKED_TOKEN_RANK } from '../entities/token.entity';

// token.rank is only refreshed for listed tokens (RefreshTokenRanksService), so
// an unlisted or not-yet-placed token reports no rank rather than a stale one.
export function visibleTokenRank(
  token: Pick<Token, 'rank' | 'unlisted'>,
): number | undefined {
  if (
    token.unlisted ||
    token.rank == null ||
    token.rank >= UNRANKED_TOKEN_RANK
  ) {
    return undefined;
  }
  return token.rank;
}
