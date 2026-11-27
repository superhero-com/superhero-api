import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const STUDIO_PAGE_SIZE = 20;
export interface StudioQuery {
  q: string;
  status: 'all' | 'published' | 'draft' | 'withdrawn';
  sort: 'newest' | 'oldest' | 'likes' | 'likes-asc' | 'views' | 'views-asc';
  days: number;
  cursor?: string;
}
export interface StudioPosition {
  value: number;
  at: number;
  id: string;
}
export function studioQuery(input: Record<string, unknown>): StudioQuery {
  const q = input.q === undefined ? '' : input.q;
  const status = input.status ?? 'all',
    sort = input.sort ?? 'newest';
  const days = input.days === undefined ? 28 : Number(input.days);
  if (
    typeof q !== 'string' ||
    q.length > 100 ||
    q.includes('\0') ||
    !['all', 'published', 'draft', 'withdrawn'].includes(status as string) ||
    !['newest', 'oldest', 'likes', 'likes-asc', 'views', 'views-asc'].includes(
      sort as string,
    ) ||
    ![7, 28, 90].includes(days) ||
    (input.days !== undefined &&
      !['string', 'number'].includes(typeof input.days)) ||
    (input.cursor !== undefined && typeof input.cursor !== 'string')
  ) {
    throw new BadRequestException('Invalid Studio filters');
  }
  return {
    q: q.trim(),
    status: status as StudioQuery['status'],
    sort: sort as StudioQuery['sort'],
    days,
    cursor: input.cursor as string | undefined,
  };
}
export function studioCursor(scope: unknown[], query: StudioQuery) {
  const binding = createHash('sha256')
    .update(
      JSON.stringify([...scope, query.q, query.status, query.sort, query.days]),
    )
    .digest('hex');
  const encode = (position: StudioPosition, direction: 'next' | 'previous') =>
    Buffer.from(
      JSON.stringify({ v: 1, binding, position, direction }),
    ).toString('base64url');
  let position: StudioPosition | undefined,
    direction: 'next' | 'previous' = 'next';
  if (query.cursor !== undefined) {
    try {
      const value = query.cursor;
      if (!value || value.length > 768 || !/^[A-Za-z0-9_-]+$/.test(value))
        throw new Error();
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.toString('base64url') !== value) throw new Error();
      const decoded = JSON.parse(bytes.toString('utf8')),
        p = decoded.position;
      if (
        decoded.v !== 1 ||
        decoded.binding !== binding ||
        !['next', 'previous'].includes(decoded.direction) ||
        !p ||
        !Number.isSafeInteger(p.value) ||
        p.value < 0 ||
        !Number.isSafeInteger(p.at) ||
        p.at < 0 ||
        typeof p.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id)
      )
        throw new Error();
      position = { value: p.value, at: p.at, id: p.id };
      direction = decoded.direction;
    } catch {
      throw new BadRequestException('Invalid Studio page cursor');
    }
  }
  return { position, direction, encode };
}
