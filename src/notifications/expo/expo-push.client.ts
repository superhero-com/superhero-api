import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { chunk } from '../common/chunk';
import notificationsConfig from '../notifications.config';

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPT_ENDPOINT = 'https://exp.host/--/api/v2/push/getReceipts';
const EXPO_RECEIPT_ID_CHUNK = 1000;
export const EXPO_PUSH_TOKEN_REGEX =
  /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;

export interface ExpoPushMessage {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
}

export interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface ExpoPushReceipt {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

/**
 * Structured error from the Expo HTTP layer. Carries the upstream status (or 0
 * if the request was aborted before any response) and a body snippet so Bull
 * retries see a readable message rather than a generic `SyntaxError: Unexpected
 * token <`.
 */
export class ExpoPushClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ExpoPushClientError';
  }
}

/** True for syntactically valid Expo push tokens. */
export function isExpoPushToken(token: unknown): token is string {
  return typeof token === 'string' && EXPO_PUSH_TOKEN_REGEX.test(token);
}

/**
 * Minimal HTTP client over the Expo Push API. Encapsulates chunking, sending and
 * receipt polling, and mirrors the surface of `expo-server-sdk` so it can be swapped
 * for the official SDK later without touching callers.
 */
@Injectable()
export class ExpoPushClient {
  private readonly logger = new Logger(ExpoPushClient.name);

  constructor(
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  isExpoPushToken(token: unknown): token is string {
    return isExpoPushToken(token);
  }

  chunkReceiptIds(ids: string[]): string[][] {
    return chunk(ids, EXPO_RECEIPT_ID_CHUNK);
  }

  /** POST one chunk of messages; returns one ticket per message (order preserved). */
  async sendPushNotificationsAsync(
    messages: ExpoPushMessage[],
  ): Promise<ExpoPushTicket[]> {
    const response = await this.post<{ data?: ExpoPushTicket[] }>(
      EXPO_PUSH_ENDPOINT,
      messages,
    );
    return response?.data ?? [];
  }

  /** Fetch delivery receipts for previously-returned ticket ids. */
  async getPushNotificationReceiptsAsync(
    ticketIds: string[],
  ): Promise<Record<string, ExpoPushReceipt>> {
    const response = await this.post<{
      data?: Record<string, ExpoPushReceipt>;
    }>(EXPO_RECEIPT_ENDPOINT, { ids: ticketIds });
    return response?.data ?? {};
  }

  private async post<T>(url: string, body: unknown): Promise<T | null> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (this.config.expoAccessToken) {
      headers.Authorization = `Bearer ${this.config.expoAccessToken}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.expoFetchTimeoutMs,
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        throw new ExpoPushClientError(
          `Expo push API timeout after ${this.config.expoFetchTimeoutMs}ms`,
          0,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const contentType = response.headers.get('content-type') ?? '';
    // Treat missing content-type as JSON-permissive — some proxies strip the
    // header on 200 responses for otherwise-valid JSON bodies; refusing them
    // would trigger Bull retries against successful pushes.
    const isJson =
      contentType === '' || contentType.includes('application/json');

    if (!response.ok) {
      const body = await safeText(response);
      throw new ExpoPushClientError(
        `Expo push API ${response.status}`,
        response.status,
        truncate(body),
      );
    }

    if (!isJson) {
      const text = await safeText(response);
      throw new ExpoPushClientError(
        `Expo push API ${response.status} returned non-JSON (content-type: "${contentType}")`,
        response.status,
        truncate(text),
      );
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      // Body was claimed to be JSON but failed to parse — surface as a
      // structured error so Bull's retry path doesn't see a generic SyntaxError.
      throw new ExpoPushClientError(
        `Expo push API ${response.status} returned invalid JSON`,
        response.status,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

function safeText(response: Response): Promise<string> {
  return response.text().catch(() => '');
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
