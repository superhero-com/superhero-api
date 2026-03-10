import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

type LoggerLike = Pick<Logger, 'warn'>;

export type XTokenEndpoint = {
  baseUrl: string;
  url: string;
  body: URLSearchParams;
};

type GetXAppAccessTokenParams = {
  appKey?: string;
  appSecret?: string;
  tokenEndpoints: XTokenEndpoint[];
  logger: LoggerLike;
  missingCredentialsMessage: string;
  tokenFailureMessage: string;
  tokenErrorPrefix: string;
  timeoutMs: number;
};

@Injectable()
export class ProfileXApiClientService {
  private static readonly DEFAULT_X_APP_TOKEN_TTL_SECONDS = 3600;
  private static readonly X_APP_TOKEN_MAX_ATTEMPTS = 3;
  private static readonly X_APP_TOKEN_RETRY_BASE_DELAY_MS = 500;
  private static readonly X_APP_TOKEN_FAILURE_COOLDOWN_MS = 60_000;
  private static readonly X_READ_API_BASE_URLS = [
    'https://api.x.com',
    'https://api.twitter.com',
  ];

  private readonly xAppAccessTokenCache = new Map<
    string,
    { token: string; expiresAtMs: number }
  >();
  private readonly xAppTokenFetchBlockedUntilMs = new Map<string, number>();
  private readonly preferredXReadBaseUrlByKey = new Map<string, string>();

  async getXAppAccessToken(
    params: GetXAppAccessTokenParams,
  ): Promise<string | null> {
    const { appKey, appSecret } = params;
    if (!appKey || !appSecret) {
      params.logger.warn(params.missingCredentialsMessage);
      return null;
    }

    const cacheKey = this.buildTokenCacheKey(
      appKey,
      appSecret,
      params.tokenEndpoints,
    );
    const cachedToken = this.xAppAccessTokenCache.get(cacheKey);
    if (cachedToken && cachedToken.expiresAtMs > Date.now()) {
      return cachedToken.token;
    }

    const blockedUntilMs = this.xAppTokenFetchBlockedUntilMs.get(cacheKey) || 0;
    if (blockedUntilMs > Date.now()) {
      return null;
    }

    try {
      const basicAuth = Buffer.from(`${appKey}:${appSecret}`, 'utf-8').toString(
        'base64',
      );
      let payload: any = {};
      let lastStatus: number | null = null;
      let lastBaseUrl = ProfileXApiClientService.X_READ_API_BASE_URLS[0];
      let lastDetail: string | null = null;

      for (
        let attempt = 1;
        attempt <= ProfileXApiClientService.X_APP_TOKEN_MAX_ATTEMPTS;
        attempt += 1
      ) {
        let shouldRetry = false;
        let hadNetworkError = false;

        try {
          for (const endpoint of params.tokenEndpoints) {
            const response = await this.fetchWithTimeout(
              endpoint.url,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  Authorization: `Basic ${basicAuth}`,
                },
                body: endpoint.body.toString(),
              },
              params.timeoutMs,
            );
            payload = await response.json().catch(() => ({}));
            lastStatus = response.status;
            lastBaseUrl = endpoint.baseUrl;
            lastDetail = this.extractXApiErrorDetail(payload);

            if (response.ok && (payload as any)?.access_token) {
              const expiresInSeconds = Number((payload as any).expires_in);
              const ttlSeconds =
                Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
                  ? expiresInSeconds
                  : ProfileXApiClientService.DEFAULT_X_APP_TOKEN_TTL_SECONDS;
              const token = String((payload as any).access_token);
              this.xAppAccessTokenCache.set(cacheKey, {
                token,
                expiresAtMs: Date.now() + Math.max(ttlSeconds - 60, 30) * 1000,
              });
              this.xAppTokenFetchBlockedUntilMs.set(cacheKey, 0);
              return token;
            }

            if (this.shouldRetryXTokenFetch(response.status)) {
              shouldRetry = true;
            }
          }
        } catch (error) {
          hadNetworkError = true;
          if (attempt === ProfileXApiClientService.X_APP_TOKEN_MAX_ATTEMPTS) {
            throw error;
          }
        }

        if (
          attempt === ProfileXApiClientService.X_APP_TOKEN_MAX_ATTEMPTS ||
          (!shouldRetry && !hadNetworkError)
        ) {
          break;
        }

        const delayMs =
          ProfileXApiClientService.X_APP_TOKEN_RETRY_BASE_DELAY_MS *
          2 ** (attempt - 1);
        await this.sleep(delayMs);
      }

      params.logger.warn(params.tokenFailureMessage, {
        base_url: lastBaseUrl,
        status: lastStatus,
        error: (payload as any)?.error,
        error_description: (payload as any)?.error_description,
        detail:
          lastDetail || (payload as any)?.detail || (payload as any)?.title,
      });
      this.xAppTokenFetchBlockedUntilMs.set(
        cacheKey,
        Date.now() + ProfileXApiClientService.X_APP_TOKEN_FAILURE_COOLDOWN_MS,
      );
      return null;
    } catch (error) {
      params.logger.warn(
        `${params.tokenErrorPrefix}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async fetchXReadWithAuthFallback(
    pathAndQuery: string,
    bearerToken: string,
    timeoutMs: number,
    preferredBaseUrlKey = 'default',
  ): Promise<{ response: Response; body: any; baseUrl: string }> {
    let lastResponse: Response | null = null;
    let lastBody: any = {};
    let lastBaseUrl = ProfileXApiClientService.X_READ_API_BASE_URLS[0];

    for (const baseUrl of this.getOrderedXReadApiBaseUrls(
      preferredBaseUrlKey,
    )) {
      const endpoint = `${baseUrl}${pathAndQuery}`;
      const response = await this.fetchWithTimeout(
        endpoint,
        {
          headers: {
            Authorization: `Bearer ${String(bearerToken || '').trim()}`,
          },
        },
        timeoutMs,
      );
      const body = await response.json().catch(() => ({}));
      lastResponse = response;
      lastBody = body;
      lastBaseUrl = baseUrl;

      if (response.ok) {
        this.preferredXReadBaseUrlByKey.set(preferredBaseUrlKey, baseUrl);
        return { response, body, baseUrl };
      }

      if (!this.isUnsupportedAuthenticationError(response.status, body)) {
        return { response, body, baseUrl };
      }
    }

    if (!lastResponse) {
      throw new Error('No response received from X read endpoints');
    }

    return { response: lastResponse, body: lastBody, baseUrl: lastBaseUrl };
  }

  extractXApiErrorDetail(body: any): string | null {
    if (!body || typeof body !== 'object') {
      return null;
    }

    const topLevel =
      body.error_description || body.detail || body.title || body.error || null;
    if (topLevel) {
      return String(topLevel);
    }

    const firstError = Array.isArray(body.errors) ? body.errors[0] : null;
    if (!firstError || typeof firstError !== 'object') {
      return null;
    }

    const code = firstError.code ? `code=${String(firstError.code)}` : null;
    const message = firstError.message ? String(firstError.message) : null;
    if (code && message) {
      return `${code} ${message}`;
    }

    return code || message || null;
  }

  private getOrderedXReadApiBaseUrls(preferredBaseUrlKey: string): string[] {
    const preferred = this.preferredXReadBaseUrlByKey.get(preferredBaseUrlKey);
    if (!preferred) {
      return [...ProfileXApiClientService.X_READ_API_BASE_URLS];
    }

    return [
      preferred,
      ...ProfileXApiClientService.X_READ_API_BASE_URLS.filter(
        (baseUrl) => baseUrl !== preferred,
      ),
    ];
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, {
        ...(init || {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private isUnsupportedAuthenticationError(status: number, body: any): boolean {
    if (status !== 403) {
      return false;
    }

    const detail = String(body?.detail || body?.title || '').toLowerCase();
    return (
      detail.includes('unsupported authentication') ||
      detail.includes('authenticating with unknown')
    );
  }

  private shouldRetryXTokenFetch(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private buildTokenCacheKey(
    appKey: string,
    appSecret: string,
    tokenEndpoints: XTokenEndpoint[],
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          appKey,
          appSecret,
          tokenEndpoints: tokenEndpoints.map((endpoint) => ({
            url: endpoint.url,
            body: endpoint.body.toString(),
          })),
        }),
      )
      .digest('hex');
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
