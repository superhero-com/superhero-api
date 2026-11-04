import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

// Apollo's default path; the global `api` prefix doesn't apply to it.
export const GRAPHQL_PATH = '/graphql';
// One query may hold up to 14 root lists, against REST's 10 per minute per route.
export const MAX_GRAPHQL_REQUESTS_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

/** Per client IP over a fixed one-minute window, in this process's memory. */
export class GraphqlRateLimiter {
  private readonly logger = new Logger(GraphqlRateLimiter.name);
  private windowStart = 0;
  private refused = 0;
  private readonly perClient = new Map<string, number>();

  take(client: string, now: number = Date.now()): boolean {
    if (now - this.windowStart >= WINDOW_MS) {
      if (this.refused > 0) {
        // `error`: production keeps only error-level logs.
        this.logger.error(
          `GraphQL rate limit refused ${this.refused} requests in the last minute`,
        );
      }
      this.windowStart = now;
      this.refused = 0;
      this.perClient.clear();
    }
    const used = this.perClient.get(client) ?? 0;
    if (used >= MAX_GRAPHQL_REQUESTS_PER_MINUTE) {
      this.refused++;
      return false;
    }
    this.perClient.set(client, used + 1);
    return true;
  }

  secondsUntilReset(now: number = Date.now()): number {
    return Math.max(1, Math.ceil((this.windowStart + WINDOW_MS - now) / 1000));
  }
}

/**
 * Call after enableCors, so preflights aren't counted, and before app.init(),
 * so refused requests stop ahead of the JSON parser and Apollo.
 */
export function applyGraphqlRateLimit(
  app: NestExpressApplication,
  limiter = new GraphqlRateLimiter(),
): void {
  app.use(GRAPHQL_PATH, (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (limiter.take(req.ip ?? req.socket.remoteAddress ?? 'unknown', now)) {
      return next();
    }
    res
      .status(429)
      .set('Retry-After', String(limiter.secondsUntilReset(now)))
      .json({
        errors: [
          {
            message: `Rate limit exceeded: at most ${MAX_GRAPHQL_REQUESTS_PER_MINUTE} GraphQL requests per minute`,
            extensions: { code: 'RATE_LIMITED' },
          },
        ],
      });
  });
}
