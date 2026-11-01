import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ShortsAuthService } from './shorts-auth.service';
import { ShortsRateService } from './shorts-rate.service';
import { SHORTS_HTTP_POLICY } from './shorts-rate-policy';
import { ShortsMeasurementMonitorService } from './shorts-measurement-monitor.service';

@Injectable()
export class ShortsRateGuard implements CanActivate {
  constructor(
    private readonly auth: ShortsAuthService,
    @Optional() private readonly rates?: ShortsRateService,
    @Optional() private readonly measurements?: ShortsMeasurementMonitorService,
  ) {}
  async canActivate(context: ExecutionContext) {
    // The explicit loopback demo has no Redis dependency. A hosted session
    // adapter may never bypass shared admission when its provider is missing.
    if (!this.rates) {
      if (this.auth.shared)
        throw new ServiceUnavailableException(
          'Shared Shorts request limits are unavailable',
        );
      return true;
    }
    const policy = SHORTS_HTTP_POLICY[context.getHandler().name];
    if (!policy)
      throw new ServiceUnavailableException(
        'Shorts route admission is not configured',
      );
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    try {
      const ip = this.rates.config.client(request);
      await this.rates.request(policy, ip);
      if (policy.private) {
        const actor = await this.auth.authenticate(
          request.headers.authorization,
        );
        if (policy.group === 'operator')
          await this.auth.operator(request.headers.authorization);
        if (policy.bytes) {
          const length = request.headers['content-length'];
          if (
            length !== undefined &&
            (!/^\d{1,10}$/.test(length) ||
              Number(length) > policy.bytes + 65536)
          )
            throw new BadRequestException('Upload body is too large');
        }
        await this.rates.actor(policy, ip, actor);
      }
      return true;
    } catch (error) {
      if (context.getHandler().name === 'playback') {
        const status = error instanceof HttpException ? error.getStatus() : 500;
        this.measurements?.failure(status);
      }
      if (
        error instanceof HttpException &&
        [429, 503].includes(error.getStatus())
      ) {
        const body = error.getResponse() as { retryAfter?: number };
        response.setHeader('Retry-After', String(body.retryAfter || 1));
        response.setHeader('Cache-Control', 'no-store');
      }
      throw error;
    }
  }
}
