import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import tgrConfig, { isRelayConfigured } from '../config/tgr.config';
import { createGroup, deleteGroup } from './nip29';
import { normalizePubkey } from './pubkey';
import { RELAY_WRITER, type RelayWriter } from './relay-writer.contract';

/**
 * Optional config-fallback for the relay's admin pubkey, read directly from the
 * environment (the shared `tgr.config.ts` is owned by Task 01 and not modified
 * here). Only consulted when the NIP-11 relay-info document does NOT advertise a
 * `pubkey`. May be npub or hex; normalized before comparison.
 */
export const RELAY_ADMIN_PUBKEY_ENV = 'TG_RELAY_ADMIN_PUBKEY';

/** A reserved `h`-tag for the disposable create/delete publish probe (Req 1). */
export const HEALTH_PROBE_GROUP_PREFIX = 'tgr-relay-admin-health-probe';

/**
 * The abuse vector the relay-admin check defends against — included verbatim in
 * the fail-fast log so an operator sees WHY being relay admin is mandatory.
 */
export const ABUSE_VECTOR_NOTE =
  'A pre-existing event under a managed h-tag (= a future sale_address) blocks a ' +
  'non-admin create — groups_relay rejects with "Only relay admin can create a ' +
  'managed group from an unmanaged one" (groups.rs:445–450). Being the relay ' +
  'admin is the mitigation; this worker must run as the relay-admin key.';

/**
 * Minimal NIP-11 relay-information shape we read (the `pubkey` field). The
 * `groups_relay` serves its admin pubkey here (verified — `server.rs:85`,
 * `supported_nips` includes 11): `RelayInfo { pubkey, supported_nips, … }`.
 */
interface Nip11RelayInfo {
  pubkey?: string;
  supported_nips?: number[];
  name?: string;
}

/**
 * Startup fail-fast health-check: verifies the bot key is the `groups_relay` admin
 * and can create/publish (Task 08 Req 1, plan §6.4 / D7). Relay-gated (worker mode
 * removed — see `deworker-plan.md`): runs only when a relay is configured; with no
 * relay the writer is dormant, so there is nothing to verify and the check is
 * skipped (the API still boots).
 *
 * On bootstrap it:
 *  1. derives the bot pubkey from the relay writer (already decoded from
 *     `TG_BOT_NSEC`; the nsec is NEVER logged, §10);
 *  2. obtains the relay's advertised admin pubkey — primary: the NIP-11
 *     relay-info `pubkey` (fetched over `TG_RELAY_URL` with
 *     `Accept: application/nostr+json`; ws→http); fallback: the
 *     `TG_RELAY_ADMIN_PUBKEY` env when NIP-11 omits `pubkey`;
 *  3. asserts bot-pubkey == relay-admin-pubkey;
 *  4. confirms publish authority via a disposable `9007`(+`9008`) probe under a
 *     reserved health `h`-tag, expecting an OK / benign already-exists;
 *  5. THROWS on any failure → crashes the worker container, naming the abuse
 *     vector ({@link ABUSE_VECTOR_NOTE}) in the log.
 *
 * ### Spike outcome (recorded)
 * `groups_relay` DOES advertise its admin pubkey via NIP-11 (`RelayInfo.pubkey`,
 * `server.rs:82–91`; `supported_nips: [1,9,11,29,40,42,70]`). The NIP-11 path is
 * therefore primary; the `TG_RELAY_ADMIN_PUBKEY` config fallback exists only
 * for relays that omit `pubkey`.
 */
@Injectable()
export class RelayAdminHealthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RelayAdminHealthService.name);

  constructor(
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
    @Inject(RELAY_WRITER)
    private readonly relay: RelayWriter,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!isRelayConfigured(this.config)) {
      this.logger.log(
        'relay not configured (TG_RELAY_URL/TG_BOT_NSEC unset) — skipping ' +
          'relay-admin health-check; NIP-29 publishing is disabled',
      );
      return;
    }
    // Run the check in the BACKGROUND, never blocking app bootstrap. This hook is
    // awaited inside `app.init()`, so awaiting a relay round-trip here would block
    // `app.listen()` (port never opens) when the relay is slow/half-open, and a
    // probe failure would `throw` straight out of the lifecycle hook and crash the
    // whole process. The HTTP API + indexer MUST come up regardless of the relay
    // (relay duties self-heal/retry), so we fire-and-forget and downgrade a failure
    // to a loud log instead of a crash.
    void this.verifySafely();
  }

  /** Run {@link verify} detached from bootstrap; a failure is logged, never thrown. */
  private async verifySafely(): Promise<void> {
    try {
      await this.verify();
    } catch (e) {
      this.logger.error(
        `relay-admin health-check failed — NIP-29 publishing may be impaired, ` +
          `but the API is up and will keep retrying the relay connection: ${
            (e as Error)?.message ?? e
          }`,
      );
    }
  }

  /**
   * Run the two checks; throw (fail fast) on either failure. Exposed (not just
   * the lifecycle hook) so it is directly unit/integration testable.
   */
  async verify(): Promise<void> {
    const botPubkey = normalizePubkey(this.relay.pubkey);
    if (!botPubkey) {
      this.fail('bot pubkey is missing or not 64-hex (check TG_BOT_NSEC)');
    }

    // 1) bot pubkey == relay admin pubkey -----------------------------------
    const relayAdmin = await this.resolveRelayAdminPubkey();
    if (!relayAdmin) {
      this.fail(
        'could not determine the relay admin pubkey: the NIP-11 relay-info ' +
          `served no "pubkey" and ${RELAY_ADMIN_PUBKEY_ENV} is unset`,
      );
    }
    if (relayAdmin !== botPubkey) {
      this.fail(
        `bot key is NOT the relay admin: bot=${short(botPubkey)} ` +
          `relay-admin=${short(relayAdmin)}`,
      );
    }

    // 2) can create/publish (disposable probe) ------------------------------
    await this.verifyCanPublish();

    this.logger.log(
      `relay-admin health OK: bot ${short(botPubkey)} is the groups_relay admin ` +
        `and can publish`,
    );
  }

  /**
   * Resolve the relay's admin pubkey: NIP-11 `pubkey` first, then the
   * `TG_RELAY_ADMIN_PUBKEY` env fallback. Returns normalized hex or
   * `undefined` if neither is available/parseable.
   */
  private async resolveRelayAdminPubkey(): Promise<string | undefined> {
    const fromNip11 = await this.fetchNip11AdminPubkey();
    if (fromNip11) {
      return fromNip11;
    }
    const fromEnv = normalizePubkey(process.env[RELAY_ADMIN_PUBKEY_ENV]);
    if (fromEnv) {
      this.logger.warn(
        `NIP-11 served no admin pubkey; falling back to ${RELAY_ADMIN_PUBKEY_ENV}`,
      );
      return fromEnv;
    }
    return undefined;
  }

  /**
   * Fetch the NIP-11 relay-info document over HTTP(S) (ws→http) with
   * `Accept: application/nostr+json` and return its normalized `pubkey`, or
   * `undefined` if the relay omits it / the fetch fails (the env fallback then
   * applies). Never throws — a fetch failure is not, on its own, fatal.
   */
  private async fetchNip11AdminPubkey(): Promise<string | undefined> {
    const httpUrl = wsUrlToHttp(this.config.nostrRelayUrl);
    if (!httpUrl) {
      return undefined;
    }
    try {
      const res = await fetch(httpUrl, {
        headers: { Accept: 'application/nostr+json' },
      });
      if (!res.ok) {
        this.logger.warn(`NIP-11 fetch returned HTTP ${res.status}`);
        return undefined;
      }
      const info = (await res.json()) as Nip11RelayInfo;
      const hex = normalizePubkey(info?.pubkey);
      if (!hex) {
        this.logger.warn('NIP-11 relay-info served no usable "pubkey"');
      }
      return hex ?? undefined;
    } catch (e) {
      this.logger.warn(`NIP-11 fetch failed: ${(e as Error)?.message ?? e}`);
      return undefined;
    }
  }

  /**
   * Confirm the bot can create/publish a managed group by publishing a disposable
   * `9007` under a reserved health `h`-tag and then cleaning it up with a `9008`.
   * A fresh `9007` from the relay admin succeeds; a non-admin would be rejected
   * with "Only relay admin can create a managed group from an unmanaged one"
   * (groups.rs:445–450) once any event exists under that h-tag. "Group already
   * exists" is a benign success. Anything else fails fast.
   */
  private async verifyCanPublish(): Promise<void> {
    const probeGid = `${HEALTH_PROBE_GROUP_PREFIX}-${Date.now()}`;
    const created = await this.relay.publish(createGroup(probeGid));
    const ok =
      created.ok ||
      (created.reason ?? '').toLowerCase().includes('already exists');
    if (!ok) {
      this.fail(
        `relay-admin publish probe failed: ${created.reason ?? 'no ACK'}`,
      );
    }
    // Best-effort cleanup of the disposable probe group (a 9008 makes the h-tag
    // terminal so it is never reused). A cleanup failure is non-fatal.
    try {
      await this.relay.publish(deleteGroup(probeGid));
    } catch {
      // ignore — the probe id is reserved/disposable.
    }
  }

  /** Throw a fail-fast error naming the abuse vector (never logs the nsec). */
  private fail(reason: string): never {
    const message = `[token-gated-rooms] relay-admin health-check FAILED: ${reason}. ${ABUSE_VECTOR_NOTE}`;
    this.logger.error(message);
    throw new Error(message);
  }
}

/**
 * Convert a relay `ws://`/`wss://` URL to its `http://`/`https://` equivalent for
 * the NIP-11 fetch. Plain `http(s)://` passes through. Returns `undefined` for a
 * blank/garbage URL.
 */
export function wsUrlToHttp(url: string | undefined): string | undefined {
  if (!url || url.trim() === '') {
    return undefined;
  }
  const trimmed = url.trim();
  if (trimmed.startsWith('wss://')) {
    return 'https://' + trimmed.slice('wss://'.length);
  }
  if (trimmed.startsWith('ws://')) {
    return 'http://' + trimmed.slice('ws://'.length);
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return undefined;
}

/** Short pubkey for logs (never the nsec). */
function short(pubkey: string | undefined): string {
  return pubkey ? pubkey.slice(0, 8) : '<none>';
}
