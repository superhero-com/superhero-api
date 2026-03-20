export const TOKEN_HASHTAG_REGEX_SOURCE =
  '#([A-Za-z0-9_][A-Za-z0-9_-]{0,49})';

export function buildNormalizedTokenMentionSelectSql(postAlias: string): string {
  return `
    SELECT DISTINCT UPPER(mention.symbol) AS symbol
    FROM (
      SELECT jsonb_array_elements_text(
        COALESCE(${postAlias}.token_mentions, '[]'::jsonb)
      ) AS symbol
      UNION ALL
      SELECT content_match[1] AS symbol
      FROM regexp_matches(
        COALESCE(${postAlias}.content, ''),
        '${TOKEN_HASHTAG_REGEX_SOURCE}',
        'g'
      ) AS content_match
      WHERE jsonb_array_length(COALESCE(${postAlias}.token_mentions, '[]'::jsonb)) = 0
    ) mention
    WHERE mention.symbol IS NOT NULL
      AND mention.symbol <> ''
  `;
}

export function buildTokenMentionExistsSql(
  postAlias: string,
  normalizedSymbolSql: string,
): string {
  return `
    EXISTS (
      SELECT 1
      FROM (${buildNormalizedTokenMentionSelectSql(postAlias)}) normalized_mentions
      WHERE normalized_mentions.symbol = ${normalizedSymbolSql}
    )
  `;
}
