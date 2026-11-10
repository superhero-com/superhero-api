import { EntityManager } from 'typeorm';
import { UNRANKED_TOKEN_RANK } from '../entities/token.entity';

// token_rank is only refreshed for listed tokens (RefreshTokenRanksService), so
// an unlisted or not-yet-placed token reports no rank rather than a stale one.
export function visibleTokenRank(token: {
  rank?: number | null;
  unlisted?: boolean;
}): number | undefined {
  if (
    token.unlisted ||
    token.rank == null ||
    token.rank >= UNRANKED_TOKEN_RANK
  ) {
    return undefined;
  }
  return token.rank;
}

/** Persisted ranks by sale address; a token not placed yet has no entry. */
export async function loadTokenRanks(
  manager: EntityManager,
  saleAddresses: string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(saleAddresses.filter(Boolean))];
  if (!unique.length) {
    return new Map();
  }
  const rows: { sale_address: string; rank: number }[] = await manager.query(
    'SELECT sale_address, rank FROM token_rank WHERE sale_address = ANY($1)',
    [unique],
  );
  return new Map(rows.map((row) => [row.sale_address, row.rank]));
}

/**
 * Sets `rank` the way the old `token.rank` column read: the persisted rank,
 * or the sentinel for a token not placed yet. For responses that serialize
 * token rows as they are.
 */
export async function attachTokenRanks(
  manager: EntityManager,
  tokens: Array<{ sale_address?: string | null } | null | undefined>,
): Promise<void> {
  const present = tokens.filter(
    (token): token is { sale_address: string } => !!token?.sale_address,
  );
  const ranks = await loadTokenRanks(
    manager,
    present.map((token) => token.sale_address),
  );
  for (const token of present) {
    (token as { rank?: number }).rank =
      ranks.get(token.sale_address) ?? UNRANKED_TOKEN_RANK;
  }
}
