import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import tgrConfig, { isRelayConfigured } from '../config/tgr.config';
import { createGroup, deleteGroup } from './nip29';
import {
  ABUSE_VECTOR_NOTE,
  verifyRelayAdminIdentity,
} from './relay-admin-identity';
import { RELAY_WRITER, type RelayWriter } from './relay-writer.contract';

/** Reserved group prefix for the disposable create/delete publish probe. */
export const HEALTH_PROBE_GROUP_PREFIX = 'tgr-relay-admin-health-probe';

/**
 * Background startup diagnostic for relay identity and group publishing. The
 * writer independently verifies admin identity before becoming healthy on every
 * connection, so an identity mismatch pauses publishing without blocking the API.
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
    await verifyRelayAdminIdentity(this.config, this.relay.pubkey);

    await this.verifyCanPublish();

    this.logger.log(
      `relay-admin health OK: bot ${short(this.relay.pubkey)} is the groups_relay admin ` +
        `and can publish`,
    );
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

/** Short pubkey for logs (never the nsec). */
function short(pubkey: string | undefined): string {
  return pubkey ? pubkey.slice(0, 8) : '<none>';
}
