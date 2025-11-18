import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const MAX_REQUESTS_PER_MINUTE = 10;
const WINDOW_MS = 60 * 1000; // 1 minute

/**
 * Rate limiting guard that allows 10 requests per minute per IP address
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly rateLimitMap = new Map<string, RateLimitEntry>();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const clientId = this.getClientId(request);
    const now = Date.now();

    // Clean up old entries periodically (every 100 requests)
    if (this.rateLimitMap.size > 1000) {
      this.cleanup(now);
    }

    const entry = this.rateLimitMap.get(clientId);

    if (!entry || now > entry.resetTime) {
      // New window or expired entry
      this.rateLimitMap.set(clientId, {
        count: 1,
        resetTime: now + WINDOW_MS,
      });
      return true;
    }

    if (entry.count >= MAX_REQUESTS_PER_MINUTE) {
      // Rate limit exceeded
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      throw new HttpException(
        {
          status: HttpStatus.TOO_MANY_REQUESTS,
          message: `Rate limit exceeded. Maximum ${MAX_REQUESTS_PER_MINUTE} requests per minute.`,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Increment count
    entry.count++;
    return true;
  }

  private getClientId(request: Request): string {
    // Use IP address as client identifier
    // Check for forwarded IP (if behind proxy)
    const forwarded = request.headers['x-forwarded-for'];
    const ip =
      (typeof forwarded === 'string'
        ? forwarded.split(',')[0].trim()
        : forwarded?.[0]) ||
      request.ip ||
      request.socket.remoteAddress ||
      'unknown';

    // Include the route path to rate limit per endpoint
    const route = request.route?.path || request.path;
    return `${ip}:${route}`;
  }

  private cleanup(now: number): void {
    // Remove expired entries
    for (const [key, entry] of this.rateLimitMap.entries()) {
      if (now > entry.resetTime) {
        this.rateLimitMap.delete(key);
      }
    }
  }
}

