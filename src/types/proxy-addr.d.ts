declare module 'proxy-addr' {
  type TrustFunction = (addr: string, index: number) => boolean;

  interface ProxyAddrRequest {
    headers: Record<string, unknown>;
    socket?: { remoteAddress?: string };
    connection?: { remoteAddress?: string };
  }

  function proxyaddr(
    req: ProxyAddrRequest,
    trust: TrustFunction | string | string[],
  ): string;

  namespace proxyaddr {
    function compile(val: string | string[]): TrustFunction;
    function all(
      req: ProxyAddrRequest,
      trust?: TrustFunction | string | string[],
    ): string[];
  }

  export = proxyaddr;
}
