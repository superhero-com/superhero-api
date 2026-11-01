import { BadRequestException } from '@nestjs/common';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import proxyaddr from 'proxy-addr';
import ipaddr from 'ipaddr.js';
import type { Request } from 'express';
import type { RedisOptions } from 'ioredis';
import { REDIS_CONFIG } from '../configs/redis';

export const SHORTS_RATE_CONFIG = Symbol('SHORTS_RATE_CONFIG');
export interface ShortsRateConfig {
  key: Buffer;
  client: (request: Request) => string;
  redis: RedisOptions;
}

/** Explicit trusted hops only. Never inherit Express's permissive boolean/hop count. */
export function shortsClientIdentity(raw = process.env.TRUST_PROXY) {
  const value = raw?.trim();
  const ranges =
    !value || ['false', '0'].includes(value)
      ? []
      : value.split(',').map((entry) => entry.trim());
  if (ranges.length > 32 || (value?.length || 0) > 2048)
    throw new Error('Shorts requires a bounded TRUST_PROXY address allowlist');
  for (const range of ranges) {
    const [address, prefix, extra] = range.split('/');
    const version = isIP(address);
    if (
      !version ||
      address.includes('%') ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d{1,3}$/.test(prefix) ||
          Number(prefix) < 1 ||
          Number(prefix) > (version === 4 ? 32 : 128)))
    )
      throw new Error(
        'Shorts requires explicit TRUST_PROXY IPs/CIDRs, or false for direct access',
      );
  }
  const trust = proxyaddr.compile(ranges);
  return (request: Request) => {
    try {
      const peer = request.socket.remoteAddress;
      if (!peer || !isIP(peer) || peer.includes('%')) throw new Error();
      let client = peer;
      if (trust(peer, 0)) {
        const forwarded = request.headers['x-forwarded-for'];
        if (
          forwarded !== undefined &&
          (typeof forwarded !== 'string' ||
            forwarded.length > 1024 ||
            forwarded.split(',').length > 16)
        )
          throw new Error();
        client = proxyaddr(request, trust);
      }
      if (!isIP(client) || client.includes('%')) throw new Error();
      const address = ipaddr.process(client);
      // IPv4-mapped IPv6 uses the same identity as IPv4. IPv6 privacy addresses
      // share a /64 budget; changing an interface ID must not reset admission.
      const bytes = address.toByteArray();
      return address.kind() === 'ipv4'
        ? `v4:${bytes.join('.')}`
        : `v6:${Buffer.from(bytes.slice(0, 8)).toString('hex')}`;
    } catch {
      throw new BadRequestException('Invalid client network identity');
    }
  };
}

export async function shortsRateConfig(): Promise<ShortsRateConfig> {
  const client = shortsClientIdentity();
  const path = process.env.SHORTS_RATE_KEY_FILE;
  if (!isAbsolute(path || ''))
    throw new Error('SHORTS_RATE_KEY_FILE must be an absolute secret path');
  const file = await open(path!, constants.O_RDONLY | constants.O_NOFOLLOW);
  let key: Buffer;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 256 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error('Invalid Shorts rate-key permissions or size');
    const buffer = Buffer.alloc(257);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const hex = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (bytesRead > 256 || !/^[a-f0-9]{64}$/.test(hex))
      throw new Error('Invalid Shorts rate key');
    key = Buffer.from(hex, 'hex');
  } finally {
    await file.close();
  }
  return { key, client, redis: REDIS_CONFIG };
}
