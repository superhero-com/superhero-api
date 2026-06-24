describe('resolveClientIp', () => {
  const ORIGINAL_TRUST_PROXY = process.env.TRUST_PROXY;

  afterEach(() => {
    if (ORIGINAL_TRUST_PROXY === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = ORIGINAL_TRUST_PROXY;
    }
    jest.resetModules();
  });

  /**
   * `resolveClientIp` compiles its trust function ONCE at module load from
   * `process.env.TRUST_PROXY` (it never changes at runtime in the real app),
   * so exercising different values requires a fresh module instance per case.
   */
  function loadWithTrustProxy(
    value: string | undefined,
  ): typeof import('./client-ip').resolveClientIp {
    jest.resetModules();
    if (value === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = value;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./client-ip').resolveClientIp;
  }

  it('returns the raw peer address when TRUST_PROXY is unset (no proxy trusted)', () => {
    const resolveClientIp = loadWithTrustProxy(undefined);
    expect(resolveClientIp({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.1')).toBe(
      '10.0.0.1',
    );
  });

  it('returns the raw peer address when TRUST_PROXY=false (explicit no-trust)', () => {
    const resolveClientIp = loadWithTrustProxy('false');
    expect(resolveClientIp({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.1')).toBe(
      '10.0.0.1',
    );
  });

  it('trusts a single hop (TRUST_PROXY=1): resolves through X-Forwarded-For instead of the raw peer', () => {
    // Regression: this is the exact bug — without trust resolution, every
    // socket.io connection's "IP" is the reverse proxy's own address.
    const resolveClientIp = loadWithTrustProxy('1');
    expect(resolveClientIp({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.1')).toBe(
      '1.2.3.4',
    );
  });

  it('walks multiple trusted hops with TRUST_PROXY=2', () => {
    const resolveClientIp = loadWithTrustProxy('2');
    expect(
      resolveClientIp({ 'x-forwarded-for': '1.2.3.4, 5.5.5.5' }, '10.0.0.1'),
    ).toBe('1.2.3.4');
  });

  it('trusts everything with TRUST_PROXY=true: resolves the original (leftmost) client address', () => {
    const resolveClientIp = loadWithTrustProxy('true');
    expect(
      resolveClientIp({ 'x-forwarded-for': '1.2.3.4, 5.5.5.5' }, '10.0.0.1'),
    ).toBe('1.2.3.4');
  });

  it('falls back to the raw peer when X-Forwarded-For is absent, even with trust configured', () => {
    const resolveClientIp = loadWithTrustProxy('true');
    expect(resolveClientIp({}, '10.0.0.1')).toBe('10.0.0.1');
  });

  it('stops at the first untrusted hop for a preset value (e.g. "loopback") that does not match the raw peer', () => {
    const resolveClientIp = loadWithTrustProxy('loopback');
    expect(resolveClientIp({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.1')).toBe(
      '10.0.0.1',
    );
  });

  it('trusts a matching CIDR range and resolves through it', () => {
    const resolveClientIp = loadWithTrustProxy('10.0.0.0/8');
    expect(resolveClientIp({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.1')).toBe(
      '1.2.3.4',
    );
  });
});
