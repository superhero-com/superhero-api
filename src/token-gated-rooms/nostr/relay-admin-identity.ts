import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type tgrConfig from '../config/tgr.config';
import { normalizePubkey } from './pubkey';

export const RELAY_ADMIN_PUBKEY_ENV = 'TG_RELAY_ADMIN_PUBKEY';

export const ABUSE_VECTOR_NOTE =
  'A pre-existing event under a managed h-tag (= a future sale_address) blocks a ' +
  'non-admin create: groups_relay rejects with "Only relay admin can create a ' +
  'managed group from an unmanaged one". The bot must use the relay-admin key.';

type RelayIdentityConfig = Pick<
  ConfigType<typeof tgrConfig>,
  'nostrRelayUrl' | 'publishAckTimeoutMs'
>;

const logger = new Logger('RelayAdminIdentity');

/** NIP-42 authenticates an identity; it does not grant relay-admin authority. */
export async function verifyRelayAdminIdentity(
  config: RelayIdentityConfig,
  pubkey: string,
  requireNip11 = false,
): Promise<void> {
  const bot = normalizePubkey(pubkey);
  let reason: string;
  if (!bot) {
    reason = 'bot pubkey is missing or not 64-hex (check TG_BOT_NSEC)';
  } else {
    const admin = await resolveRelayAdminPubkey(config, requireNip11);
    if (!admin) {
      reason = requireNip11
        ? 'could not determine the relay admin pubkey: NIP-11 must advertise it after a relay-admin rejection'
        : 'could not determine the relay admin pubkey: the NIP-11 relay-info ' +
          `served no "pubkey" and ${RELAY_ADMIN_PUBKEY_ENV} is unset`;
    } else if (admin !== bot) {
      reason = `bot key is NOT the relay admin: bot=${bot.slice(0, 8)} relay-admin=${admin.slice(0, 8)}`;
    }
  }
  if (reason) {
    throw new Error(
      `[token-gated-rooms] relay-admin health-check FAILED: ${reason}. ${ABUSE_VECTOR_NOTE}`,
    );
  }
}

async function resolveRelayAdminPubkey(
  config: RelayIdentityConfig,
  requireNip11: boolean,
): Promise<string | undefined> {
  const httpUrl = wsUrlToHttp(config.nostrRelayUrl);
  if (httpUrl) {
    try {
      // Bound both the response and JSON body read so a half-configured HTTP
      // endpoint cannot wedge connection readiness forever.
      const res = await fetch(httpUrl, {
        headers: { Accept: 'application/nostr+json' },
        signal: AbortSignal.timeout(config.publishAckTimeoutMs ?? 5000),
      });
      if (res.ok) {
        const info = (await res.json()) as { pubkey?: string };
        const admin = normalizePubkey(info?.pubkey);
        if (admin) return admin;
        logger.warn('NIP-11 relay-info served no usable "pubkey"');
      } else {
        logger.warn(`NIP-11 fetch returned HTTP ${res.status}`);
      }
    } catch (error) {
      logger.warn(`NIP-11 fetch failed: ${(error as Error)?.message ?? error}`);
    }
  }

  // A definitive relay rejection disproves a configured fallback. Do not let
  // that same fallback reopen the publish queue after every reconnect.
  if (requireNip11) return undefined;
  const fallback = normalizePubkey(process.env[RELAY_ADMIN_PUBKEY_ENV]);
  if (fallback) {
    logger.warn(
      `NIP-11 served no admin pubkey; falling back to ${RELAY_ADMIN_PUBKEY_ENV}`,
    );
  }
  return fallback;
}

/** Convert a relay WebSocket URL to HTTP(S) for NIP-11. */
export function wsUrlToHttp(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  const trimmed = url.trim();
  if (trimmed.startsWith('wss://')) return 'https://' + trimmed.slice(6);
  if (trimmed.startsWith('ws://')) return 'http://' + trimmed.slice(5);
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return undefined;
}
