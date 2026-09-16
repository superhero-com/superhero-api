import { ProfileXVerificationAttemptService } from './profile-x-verification-attempt.service';

describe('ProfileXVerificationAttemptService', () => {
  const build = (insert: jest.Mock) =>
    new ProfileXVerificationAttemptService({ insert } as any);

  it('records a failure with its code and handle', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);

    await build(insert).record({
      address: 'ak_test',
      source: 'manual_recheck',
      outcome: 'failed',
      xUsername: 'someone',
      errorCode: 'x_user_lookup_failed',
      detail: 'HTTP 404 from X',
    });

    expect(insert).toHaveBeenCalledWith({
      address: 'ak_test',
      source: 'manual_recheck',
      outcome: 'failed',
      x_username: 'someone',
      error_code: 'x_user_lookup_failed',
      detail: 'HTTP 404 from X',
    });
  });

  it('stores nulls rather than undefined when a handle is not known yet', async () => {
    // A lookup can fail before any handle is resolved, and that attempt is
    // exactly the one worth seeing — it must still be written.
    const insert = jest.fn().mockResolvedValue(undefined);

    await build(insert).record({
      address: 'ak_test',
      source: 'link_intake',
      outcome: 'failed',
      errorCode: 'x_user_lookup_failed',
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ x_username: null, detail: null }),
    );
  });

  it('never lets a write failure escape into the verification it describes', async () => {
    // The whole point of the table is explaining failures. A fault in it must
    // not manufacture one.
    const insert = jest.fn().mockRejectedValue(new Error('table is gone'));

    await expect(
      build(insert).record({
        address: 'ak_test',
        source: 'manual_recheck',
        outcome: 'succeeded',
      }),
    ).resolves.toBeUndefined();
  });

  it('truncates an oversized provider message instead of storing it whole', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);

    await build(insert).record({
      address: 'ak_test',
      source: 'manual_recheck',
      outcome: 'failed',
      errorCode: 'x_posts_fetch_failed',
      detail: 'x'.repeat(2000),
    });

    expect(insert.mock.calls[0][0].detail).toHaveLength(500);
  });

  it('treats a blank detail as no detail', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);

    await build(insert).record({
      address: 'ak_test',
      source: 'manual_recheck',
      outcome: 'failed',
      errorCode: 'rate_limited',
      detail: '   ',
    });

    expect(insert.mock.calls[0][0].detail).toBeNull();
  });
});
