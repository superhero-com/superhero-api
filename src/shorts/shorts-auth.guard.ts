import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ShortsAuthService } from './shorts-auth.service';

@Injectable()
export class ShortsAuthGuard implements CanActivate {
  constructor(private readonly auth: ShortsAuthService) {}

  async canActivate(context: ExecutionContext) {
    // Nest guards run before multipart interceptors allocate upload buffers.
    const request = context.switchToHttp().getRequest<Request>();
    await this.auth.authenticate(request.headers.authorization);
    return true;
  }
}
