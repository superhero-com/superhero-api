import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Encoded } from '@aeternity/aepp-sdk';
import BigNumber from 'bignumber.js';
import { IsNull, LessThan, Repository } from 'typeorm';
import { Token } from '@/tokens/entities/token.entity';
import { NotificationService } from '../core/notification.service';
import {
  PriceAlertDirection,
  TokenPriceAlert,
} from '../entities/token-price-alert.entity';
import { TokenPriceAlertNotification } from '../notifications/token-price-alert.notification';

/** Max active (not yet fired) alerts per account. */
export const PRICE_ALERT_MAX_ACTIVE = 20;
/** Fired alerts are kept this long so the UI can show them, then pruned. */
export const PRICE_ALERT_FIRED_RETENTION_DAYS = 30;
/** Decimal AE amount: up to 30 integer digits and 18 decimals. */
export const PRICE_ALERT_TARGET_RE = /^\d{1,30}(\.\d{1,18})?$/;

export interface PriceAlertView {
  id: number;
  sale_address: string;
  symbol: string | null;
  direction: PriceAlertDirection;
  target_ae: string;
  created_at: Date;
  triggered_at: Date | null;
}

interface CrossedRow {
  id: number;
  address: string;
  sale_address: string;
  direction: PriceAlertDirection;
  target_ae: string;
  price: string;
  symbol: string;
}

/**
 * Token price alerts (#307): users set "notify me when <token> goes above/below
 * X AE". A minute cron compares active alerts with the indexed token price and
 * fires each crossed alert once through the notification engine.
 */
@Injectable()
export class PriceAlertService {
  private readonly logger = new Logger(PriceAlertService.name);

  constructor(
    @InjectRepository(TokenPriceAlert)
    private readonly alerts: Repository<TokenPriceAlert>,
    @InjectRepository(Token)
    private readonly tokens: Repository<Token>,
    private readonly notifications: NotificationService,
  ) {}

  static assertValidTarget(targetAe: string): void {
    if (
      typeof targetAe !== 'string' ||
      !PRICE_ALERT_TARGET_RE.test(targetAe) ||
      !new BigNumber(targetAe).gt(0)
    ) {
      throw new BadRequestException(
        'target_ae must be a positive decimal AE amount',
      );
    }
  }

  async listFor(address: string): Promise<PriceAlertView[]> {
    const rows = await this.alerts.find({
      where: { address },
      order: { created_at: 'DESC' },
      take: 100,
    });
    if (rows.length === 0) {
      return [];
    }
    const saleAddresses = [...new Set(rows.map((r) => r.sale_address))];
    const tokens = await this.tokens.find({
      select: ['sale_address', 'symbol'],
      where: saleAddresses.map((sale_address) => ({ sale_address })),
    });
    const symbols = new Map(tokens.map((t) => [t.sale_address, t.symbol]));
    return rows.map((r) => ({
      id: r.id,
      sale_address: r.sale_address,
      symbol: symbols.get(r.sale_address) ?? null,
      direction: r.direction,
      target_ae: r.target_ae,
      created_at: r.created_at,
      triggered_at: r.triggered_at,
    }));
  }

  async create(
    address: string,
    saleAddress: string,
    direction: PriceAlertDirection,
    targetAe: string,
  ): Promise<PriceAlertView> {
    PriceAlertService.assertValidTarget(targetAe);
    const token = await this.tokens.findOne({
      select: ['sale_address', 'symbol', 'price'],
      where: { sale_address: saleAddress },
    });
    if (!token) {
      throw new NotFoundException('Token not found');
    }
    const price = new BigNumber(token.price?.toString() ?? '0');
    const target = new BigNumber(targetAe);
    if (direction === 'above' && price.gte(target)) {
      throw new BadRequestException('Price is already above the target');
    }
    if (direction === 'below' && price.gt(0) && price.lte(target)) {
      throw new BadRequestException('Price is already below the target');
    }
    const active = await this.alerts.count({
      where: { address, triggered_at: IsNull() },
    });
    if (active >= PRICE_ALERT_MAX_ACTIVE) {
      throw new HttpException(
        `At most ${PRICE_ALERT_MAX_ACTIVE} active price alerts per account`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const saved = await this.alerts.save(
      this.alerts.create({
        address,
        sale_address: saleAddress,
        direction,
        target_ae: targetAe,
        triggered_at: null,
      }),
    );
    return {
      id: saved.id,
      sale_address: saved.sale_address,
      symbol: token.symbol ?? null,
      direction: saved.direction,
      target_ae: saved.target_ae,
      created_at: saved.created_at,
      triggered_at: saved.triggered_at,
    };
  }

  async remove(address: string, alertId: number): Promise<void> {
    const result = await this.alerts.delete({ id: alertId, address });
    if (!result.affected) {
      throw new NotFoundException('Price alert not found');
    }
  }

  /**
   * Fire every active alert whose token price crossed its target. The UPDATE
   * ... WHERE triggered_at IS NULL RETURNING claims each alert atomically, so
   * concurrent replicas never send the same alert twice.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async checkAlerts(): Promise<number> {
    let fired = 0;
    try {
      const crossed: CrossedRow[] = await this.alerts.query(
        `UPDATE "token_price_alerts" a
            SET "triggered_at" = now()
           FROM "token" t
          WHERE a."triggered_at" IS NULL
            AND t."sale_address" = a."sale_address"
            AND t."price" > 0
            AND (
              (a."direction" = 'above' AND t."price" >= a."target_ae")
              OR (a."direction" = 'below' AND t."price" <= a."target_ae")
            )
        RETURNING a."id", a."address", a."sale_address", a."direction",
                  a."target_ae", t."price"::text AS "price", t."symbol"`,
      );
      const rows = Array.isArray(crossed?.[0]) ? (crossed[0] as any) : crossed;
      for (const row of rows ?? []) {
        await this.fire(row);
        fired += 1;
      }
    } catch (error) {
      this.logger.error('Failed to check price alerts', error as Error);
    }
    return fired;
  }

  private async fire(row: CrossedRow): Promise<void> {
    try {
      const outcome = await this.notifications.send(
        { address: row.address as Encoded.AccountAddress },
        new TokenPriceAlertNotification({
          alertId: row.id,
          saleAddress: row.sale_address,
          symbol: row.symbol,
          direction: row.direction,
          targetAe: formatAe(row.target_ae),
          priceAe: formatAe(row.price),
        }),
      );
      if (outcome.outcome === 'failed') {
        this.logger.warn(
          `Price alert ${row.id} failed for ${row.address}: ${outcome.error}`,
        );
      }
    } catch (error) {
      this.logger.error(`Price alert ${row.id} send threw`, error as Error);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneFired(): Promise<void> {
    try {
      const cutoff = new Date(
        Date.now() - PRICE_ALERT_FIRED_RETENTION_DAYS * 24 * 3600 * 1000,
      );
      // NULL (still active) never compares less than the cutoff.
      await this.alerts.delete({ triggered_at: LessThan(cutoff) });
    } catch (error) {
      this.logger.error('Failed to prune fired price alerts', error as Error);
    }
  }
}

/** Up to 6 significant digits, no exponent, trailing zeros trimmed. */
export function formatAe(value: string): string {
  const n = new BigNumber(value);
  if (!n.isFinite()) {
    return value;
  }
  const fixed = n.gte(1) ? n.toFixed(4) : n.precision(6).toFixed();
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}
