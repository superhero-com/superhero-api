import {
  InvalidMiddlewareNextUrlError,
  resolveMiddlewareNextUrl,
  resolveMiddlewareNextUrlSafely,
} from './common';

describe('resolveMiddlewareNextUrl', () => {
  const middlewareUrl = 'https://mdw.example.test/api';

  it('returns null when the middleware response has no next cursor', () => {
    expect(resolveMiddlewareNextUrl(null, middlewareUrl)).toBeNull();
    expect(resolveMiddlewareNextUrl(undefined, middlewareUrl)).toBeNull();
  });

  it('resolves relative cursors on the middleware origin and path prefix', () => {
    expect(
      resolveMiddlewareNextUrl('/v3/transactions?page=2', middlewareUrl),
    ).toBe('https://mdw.example.test/api/v3/transactions?page=2');
  });

  it('resolves same-origin absolute cursors', () => {
    expect(
      resolveMiddlewareNextUrl(
        'https://mdw.example.test/api/v3/transactions?page=2',
        middlewareUrl,
      ),
    ).toBe('https://mdw.example.test/api/v3/transactions?page=2');
  });

  it('throws for off-origin cursors so callers cannot treat partial pagination as complete', () => {
    expect(() =>
      resolveMiddlewareNextUrl(
        'https://evil.example/v3/transactions',
        middlewareUrl,
      ),
    ).toThrow(InvalidMiddlewareNextUrlError);
  });

  it('throws for malformed cursors', () => {
    expect(() =>
      resolveMiddlewareNextUrl('http://[::1', middlewareUrl),
    ).toThrow(InvalidMiddlewareNextUrlError);
  });

  it('logs and returns null in safe mode for malformed cursors', () => {
    const logger = { warn: jest.fn() };

    expect(
      resolveMiddlewareNextUrlSafely(
        'http://[::1',
        middlewareUrl,
        logger,
        'test pagination',
      ),
    ).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'test pagination: stopping pagination after invalid next URL',
      expect.any(InvalidMiddlewareNextUrlError),
    );
  });
});
