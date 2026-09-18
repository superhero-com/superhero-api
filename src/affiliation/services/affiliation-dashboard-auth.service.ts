import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { LessThan, Repository } from 'typeorm';
import { AffiliationDashboardAdmin } from '../entities/affiliation-dashboard-admin.entity';
import { AffiliationDashboardSession } from '../entities/affiliation-dashboard-session.entity';

export const AFFILIATION_DASHBOARD_COOKIE = 'sh_affiliation_session';

/** How long a login lasts before the browser must sign in again. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Lockout after this many consecutive failures. The password may be short and
 * memorable, so this — not the password's entropy — is what makes guessing it
 * impractical: the hash never leaves the database, so an attacker has no
 * offline path and must come through here.
 */
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,64}$/;

/**
 * A string discriminant, not a boolean `ok`. This repo compiles with
 * `strictNullChecks: false`, under which TypeScript does not narrow a union on
 * a boolean literal — every branch would see the success shape and the callers
 * would not type-check.
 */
export type IssuedSession = { status: 'ok'; token: string; expiresAt: Date };

export type LoginResult =
  | IssuedSession
  | { status: 'invalid' }
  | { status: 'locked'; retryAfterMs: number };

export type SetupResult =
  | IssuedSession
  | { status: 'already_configured' }
  | { status: 'invalid_username' }
  | { status: 'weak_password' };

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

@Injectable()
export class AffiliationDashboardAuthService {
  private readonly logger = new Logger(AffiliationDashboardAuthService.name);

  constructor(
    @InjectRepository(AffiliationDashboardAdmin)
    private readonly adminRepository: Repository<AffiliationDashboardAdmin>,
    @InjectRepository(AffiliationDashboardSession)
    private readonly sessionRepository: Repository<AffiliationDashboardSession>,
  ) {}

  /**
   * True while no operator exists, which is what puts the dashboards into
   * first-run setup instead of asking for a login nobody can satisfy.
   */
  async needsSetup(): Promise<boolean> {
    return (await this.adminRepository.count()) === 0;
  }

  /**
   * Claim the deployment by creating its first operator.
   *
   * Guarded by the row count rather than by a secret, so it is a land-grab:
   * whoever reaches it first wins. That is acceptable only because the window
   * is meant to be seconds — deploy, then set the password — and because the
   * unique index below settles a race even if two requests arrive together.
   */
  async setup(username: string, password: string): Promise<SetupResult> {
    const normalized = (username || '').trim().toLowerCase();
    if (!USERNAME_PATTERN.test(normalized)) {
      return { status: 'invalid_username' };
    }
    if (
      !password ||
      password.length < MIN_PASSWORD_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      return { status: 'weak_password' };
    }
    if (!(await this.needsSetup())) {
      return { status: 'already_configured' };
    }

    let admin: AffiliationDashboardAdmin;
    try {
      admin = await this.adminRepository.save(
        this.adminRepository.create({
          username: normalized,
          password_hash: await argon2.hash(password, { type: argon2.argon2id }),
          failed_login_count: 0,
          locked_until: null,
          last_login_at: new Date(),
        }),
      );
    } catch (error) {
      // The unique index is the real arbiter of the race above: the loser lands
      // here and is told the deployment is already claimed.
      this.logger.warn(
        `Affiliation dashboard setup lost a race or failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { status: 'already_configured' };
    }

    this.logger.log(
      `Affiliation dashboard operator "${normalized}" created; setup is now closed`,
    );
    return this.issueSession(admin.id);
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const normalized = (username || '').trim().toLowerCase();
    const admin = await this.adminRepository.findOne({
      where: { username: normalized },
    });

    if (!admin) {
      // Spend comparable work on an unknown username so the response time does
      // not separate "no such operator" from "wrong password".
      await argon2.hash(password || '', { type: argon2.argon2id });
      return { status: 'invalid' };
    }

    const now = Date.now();
    if (admin.locked_until && admin.locked_until.getTime() > now) {
      return {
        status: 'locked',
        retryAfterMs: admin.locked_until.getTime() - now,
      };
    }

    let verified = false;
    try {
      verified = await argon2.verify(admin.password_hash, password || '');
    } catch (error) {
      // A corrupt or truncated hash must read as a failed login, never as a
      // successful one.
      this.logger.error(
        `Could not verify the affiliation dashboard password hash: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      verified = false;
    }

    if (!verified) {
      const failures = Number(admin.failed_login_count || 0) + 1;
      const locked = failures >= MAX_FAILED_LOGINS;
      await this.adminRepository.update(
        { id: admin.id },
        {
          failed_login_count: locked ? 0 : failures,
          locked_until: locked ? new Date(now + LOCKOUT_MS) : null,
        },
      );
      if (locked) {
        this.logger.warn(
          `Affiliation dashboard login locked for "${normalized}" after ${MAX_FAILED_LOGINS} failures`,
        );
        return { status: 'locked', retryAfterMs: LOCKOUT_MS };
      }
      return { status: 'invalid' };
    }

    await this.adminRepository.update(
      { id: admin.id },
      {
        failed_login_count: 0,
        locked_until: null,
        last_login_at: new Date(),
      },
    );
    return this.issueSession(admin.id);
  }

  /**
   * Resolve a cookie to its operator, or null. Returns the admin id so a caller
   * could attribute an action later; today only its truthiness is used.
   */
  async resolveSession(token: string | undefined): Promise<number | null> {
    if (!token) {
      return null;
    }
    const session = await this.sessionRepository.findOne({
      where: { token_hash: sha256Hex(token) },
    });
    if (!session) {
      return null;
    }
    if (session.expires_at.getTime() <= Date.now()) {
      // Clean up as we go, so expired rows do not accumulate between sweeps.
      await this.sessionRepository.delete({ id: session.id });
      return null;
    }
    return session.admin_id;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) {
      return;
    }
    await this.sessionRepository.delete({ token_hash: sha256Hex(token) });
  }

  /** Drop expired rows. Cheap, indexed, and safe to call at any time. */
  async purgeExpiredSessions(): Promise<void> {
    await this.sessionRepository.delete({ expires_at: LessThan(new Date()) });
  }

  private async issueSession(adminId: number): Promise<IssuedSession> {
    // 256 bits: not guessable, and never stored — only its digest is.
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.sessionRepository.save(
      this.sessionRepository.create({
        admin_id: adminId,
        token_hash: sha256Hex(token),
        expires_at: expiresAt,
      }),
    );
    // Opportunistic and non-blocking: a failed sweep must not fail a login.
    void this.purgeExpiredSessions().catch(() => undefined);
    return { status: 'ok', token, expiresAt };
  }
}

/** Exported for the guard's CSRF check; equal-length compare, no throw. */
export function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256')
      .update(a || '', 'utf8')
      .digest(),
    createHash('sha256')
      .update(b || '', 'utf8')
      .digest(),
  );
}

export const AFFILIATION_DASHBOARD_LIMITS = {
  MAX_FAILED_LOGINS,
  LOCKOUT_MS,
  SESSION_TTL_MS,
  MIN_PASSWORD_LENGTH,
};
