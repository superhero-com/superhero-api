import { BigNumber } from 'bignumber.js';
import { BigNumberTransformer } from '@/utils/BigNumberTransformer';

/**
 * `community_room.min_token_threshold` and `token_balance.balance` are stored as
 * raw integer base units via `BigNumberTransformer` (the same column transformer
 * the entities declare). This asserts large 18-decimals values round-trip with no
 * precision loss — the gating compares raw-vs-raw (plan §5.4), so a silent float
 * truncation would corrupt eligibility.
 */
describe('raw base-unit columns round-trip via BigNumberTransformer', () => {
  const cases: Array<[string, string]> = [
    ['zero', '0'],
    ['1 token @18 decimals', '1000000000000000000'],
    ['fractional-ish large @18 decimals', '123456789012345678901234'],
    [
      'beyond Number.MAX_SAFE_INTEGER',
      '9007199254740993000000000000000000', // not representable as a JS number
    ],
  ];

  it.each(cases)('%s', (_label, raw) => {
    // DB → entity
    const fromDb = BigNumberTransformer.from(raw) as BigNumber;
    expect(fromDb).toBeInstanceOf(BigNumber);
    expect(fromDb.toFixed()).toBe(raw);

    // entity → DB (no exponential notation, no precision loss)
    const toDb = BigNumberTransformer.to(fromDb);
    expect(toDb).toBe(raw);
    expect(toDb).not.toContain('e');
  });

  it('passes through null/undefined unchanged (nullable columns)', () => {
    expect(BigNumberTransformer.from(null)).toBeNull();
    expect(BigNumberTransformer.from(undefined)).toBeUndefined();
    expect(BigNumberTransformer.to(null)).toBeNull();
    expect(BigNumberTransformer.to(undefined)).toBeUndefined();
  });
});
