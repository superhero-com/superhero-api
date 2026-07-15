import {
  cappedExponentialBackoff,
  isAlreadyExists,
  isGroupNotFound,
  isTerminalReject,
  PUBLISH_BACKOFF_CAP_MS,
  pubkeyFromTags,
  reasonText,
  TerminalPublishError,
} from '../publish-policy';

describe('cappedExponentialBackoff', () => {
  it('grows exponentially from the base across attempts 1..5', () => {
    expect(cappedExponentialBackoff(1, 1000)).toBe(1000);
    expect(cappedExponentialBackoff(2, 1000)).toBe(2000);
    expect(cappedExponentialBackoff(3, 1000)).toBe(4000);
    expect(cappedExponentialBackoff(4, 1000)).toBe(8000);
    expect(cappedExponentialBackoff(5, 1000)).toBe(16000);
  });

  it('clamps at 300000 ms (5m) for high attempts', () => {
    expect(PUBLISH_BACKOFF_CAP_MS).toBe(300000);
    for (let attempt = 10; attempt <= 100; attempt++) {
      expect(cappedExponentialBackoff(attempt, 1000)).toBe(300000);
    }
  });

  it('never exceeds the cap across the default retry range', () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(cappedExponentialBackoff(attempt)).toBeLessThanOrEqual(
        PUBLISH_BACKOFF_CAP_MS,
      );
    }
  });

  it('does not overflow for very large attempt numbers (stays at cap)', () => {
    expect(cappedExponentialBackoff(1000, 1000)).toBe(300000);
    expect(Number.isFinite(cappedExponentialBackoff(1000, 1000))).toBe(true);
  });

  it('clamps non-positive attempts to the base', () => {
    expect(cappedExponentialBackoff(0, 1000)).toBe(1000);
    expect(cappedExponentialBackoff(-3, 1000)).toBe(1000);
  });
});

describe('reasonText', () => {
  it('lowercases strings and error messages, tolerates null', () => {
    expect(reasonText('Group Already Exists')).toBe('group already exists');
    expect(reasonText(new Error('Boom'))).toBe('boom');
    expect(reasonText(null)).toBe('');
    expect(reasonText(undefined)).toBe('');
  });
});

describe('isAlreadyExists', () => {
  it('is true for "Group already exists" (groups.rs:388)', () => {
    expect(isAlreadyExists('Group already exists')).toBe(true);
    expect(isAlreadyExists(new Error('Group already exists'))).toBe(true);
  });

  it('is true for "duplicate"', () => {
    expect(isAlreadyExists('duplicate: event')).toBe(true);
  });

  it('is false for unrelated rejects', () => {
    expect(isAlreadyExists('rate-limited')).toBe(false);
    expect(isAlreadyExists('invalid event')).toBe(false);
  });
});

describe('isGroupNotFound', () => {
  it('is true for the relay "[PutUser] Group not found" member-op reject', () => {
    expect(isGroupNotFound('error: [PutUser] Group not found')).toBe(true);
    expect(isGroupNotFound(new Error('[RemoveUser] Group not found'))).toBe(
      true,
    );
  });

  it('is false for unrelated rejects (incl. terminal / already-exists)', () => {
    expect(isGroupNotFound('Group already exists')).toBe(false);
    expect(isGroupNotFound('Only relay admin can create a managed group')).toBe(
      false,
    );
    expect(isGroupNotFound('connection reset')).toBe(false);
  });
});

describe('isTerminalReject', () => {
  it('is true for "Only relay admin can create a managed group …" (D7)', () => {
    expect(
      isTerminalReject(
        'Only relay admin can create a managed group from an unmanaged one',
      ),
    ).toBe(true);
  });

  it('is true for "Group existed before and was deleted" (9008-deleted)', () => {
    expect(isTerminalReject('Group existed before and was deleted')).toBe(true);
  });

  it('is false for already-exists (that is a success no-op, not terminal)', () => {
    expect(isTerminalReject('Group already exists')).toBe(false);
  });

  it('is false for ordinary retryable rejects', () => {
    expect(isTerminalReject('connection reset')).toBe(false);
    expect(isTerminalReject('timeout')).toBe(false);
  });
});

describe('TerminalPublishError', () => {
  it('carries a terminal flag', () => {
    const e = new TerminalPublishError('nope');
    expect(e.terminal).toBe(true);
    expect(e.message).toBe('nope');
    expect(e).toBeInstanceOf(Error);
  });
});

describe('pubkeyFromTags', () => {
  const PK = 'a'.repeat(64);
  it('extracts the pubkey from a ["p", …] tag', () => {
    expect(
      pubkeyFromTags([
        ['h', 'ct_x'],
        ['p', PK],
      ]),
    ).toBe(PK);
  });

  it('extracts from a ["p", pubkey, role] tag', () => {
    expect(
      pubkeyFromTags([
        ['h', 'ct_x'],
        ['p', PK, 'admin'],
      ]),
    ).toBe(PK);
  });

  it('returns undefined for group-level events (no p tag)', () => {
    expect(pubkeyFromTags([['h', 'ct_x']])).toBeUndefined();
  });
});
