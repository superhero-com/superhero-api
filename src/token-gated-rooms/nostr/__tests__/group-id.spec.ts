import { groupIdFor } from '../group-id';

describe('groupIdFor', () => {
  it('returns sale_address verbatim when nostr_group_id is absent', () => {
    expect(groupIdFor({ sale_address: 'ct_abc123' })).toBe('ct_abc123');
  });

  it('prefers nostr_group_id when present', () => {
    expect(
      groupIdFor({ sale_address: 'ct_abc', nostr_group_id: 'ct_persisted' }),
    ).toBe('ct_persisted');
  });

  it('falls back to sale_address when nostr_group_id is null/undefined', () => {
    expect(groupIdFor({ sale_address: 'ct_x', nostr_group_id: null })).toBe(
      'ct_x',
    );
    expect(
      groupIdFor({ sale_address: 'ct_y', nostr_group_id: undefined }),
    ).toBe('ct_y');
  });

  it('preserves mixed case (no lowercasing)', () => {
    const mixed = 'ct_MiXeDCaSe_2vK7QpAaBbCc';
    expect(groupIdFor({ sale_address: mixed })).toBe(mixed);
    expect(groupIdFor({ sale_address: mixed })).not.toBe(mixed.toLowerCase());
  });

  it('does not hash, slugify, or prefix the id', () => {
    const addr = 'ct_2aBc!weird.chars_keep';
    const out = groupIdFor({ sale_address: addr });
    expect(out).toBe(addr);
    expect(out).not.toMatch(/^sh:/);
    // not a 64-char sha256 hex
    expect(out).not.toMatch(/^[0-9a-f]{64}$/);
  });
});
