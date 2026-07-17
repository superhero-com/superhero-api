import {
  decodeFeedCursor,
  encodeFeedCursor,
} from './feed-cursor.util';

describe('feed cursor util', () => {
  it('round-trips a latest cursor including seenIds', () => {
    const encoded = encodeFeedCursor({
      sort: 'latest',
      ts: 12345,
      seenIds: ['post_1', 'ct_1'],
    });
    const decoded = decodeFeedCursor(encoded, 'latest');

    expect(decoded).toEqual({
      sort: 'latest',
      ts: 12345,
      seenIds: ['post_1', 'ct_1'],
    });
  });

  it('defaults seenIds to an empty array when absent from the cursor', () => {
    const tampered = Buffer.from(
      JSON.stringify({ sort: 'latest', ts: 12345 }),
      'utf8',
    ).toString('base64url');

    const decoded = decodeFeedCursor(tampered, 'latest');

    expect(decoded).toEqual({ sort: 'latest', ts: 12345, seenIds: [] });
  });

  it('rejects a latest cursor whose seenIds is not an array of strings', () => {
    const tampered = Buffer.from(
      JSON.stringify({ sort: 'latest', ts: 12345, seenIds: [1, 2] }),
      'utf8',
    ).toString('base64url');

    expect(() => decodeFeedCursor(tampered, 'latest')).toThrow(
      'Invalid cursor',
    );
  });

  it('round-trips a hot cursor', () => {
    const encoded = encodeFeedCursor({ sort: 'hot', offset: 40 });
    const decoded = decodeFeedCursor(encoded, 'hot');

    expect(decoded).toEqual({ sort: 'hot', offset: 40 });
  });

  it('returns null for an absent cursor', () => {
    expect(decodeFeedCursor(undefined, 'latest')).toBeNull();
  });

  it('rejects a cursor encoded for a different sort', () => {
    const encoded = encodeFeedCursor({ sort: 'latest', ts: 1 });

    expect(() => decodeFeedCursor(encoded, 'hot')).toThrow(
      'Invalid cursor for sort=hot',
    );
  });

  it('rejects a malformed cursor', () => {
    expect(() => decodeFeedCursor('not-base64-json', 'latest')).toThrow(
      'Invalid cursor',
    );
  });

  it('rejects a negative hot offset', () => {
    const tampered = Buffer.from(
      JSON.stringify({ sort: 'hot', offset: -1 }),
      'utf8',
    ).toString('base64url');

    expect(() => decodeFeedCursor(tampered, 'hot')).toThrow('Invalid cursor');
  });
});
