import { Request } from 'express';

/**
 * Extracts the client IP from a request, accounting for proxies (x-forwarded-for),
 * then falling back to request.ip, socket.remoteAddress, or 'unknown'.
 * Use this in guards, controllers, and logging so IP extraction stays consistent.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  return (
    (typeof forwarded === 'string'
      ? forwarded.split(',')[0].trim()
      : forwarded?.[0]) ||
    request.ip ||
    request.socket.remoteAddress ||
    'unknown'
  );
}
