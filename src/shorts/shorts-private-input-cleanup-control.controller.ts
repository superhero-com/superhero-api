import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { isAbsolute } from 'node:path';
import { authenticateStorageControl } from './shorts-storage-control.controller';
import { ShortsPrivateInputCleanupVerifierService } from './shorts-private-input-cleanup-verifier.service';
import { privateCleanupVerifications } from './shorts-private-cleanup-batch';

@Injectable()
export class ShortsPrivateInputCleanupControlGuard implements CanActivate {
  private readonly enabled =
    process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED === 'true';
  private readonly keyFile = process.env.SHORTS_STORAGE_CONTROL_TOKEN_FILE;
  constructor() {
    if (this.enabled && (!this.keyFile || !isAbsolute(this.keyFile)))
      throw new Error(
        'Private input cleanup requires an absolute SHORTS_STORAGE_CONTROL_TOKEN_FILE',
      );
  }
  async canActivate(context: ExecutionContext) {
    if (!this.enabled) throw new NotFoundException();
    return authenticateStorageControl(context, this.keyFile!);
  }
}

/** Service-only durability verification; this controller receives no deletion credentials. */
@Controller('shorts/internal/private-input-cleanup')
@UseGuards(ShortsPrivateInputCleanupControlGuard)
export class ShortsPrivateInputCleanupControlController {
  constructor(
    private readonly verifier: ShortsPrivateInputCleanupVerifierService,
  ) {}
  @Post('verify-batch')
  @HttpCode(200)
  async verifyBatch(@Body() body: Record<string, unknown>) {
    let requests: ReturnType<typeof privateCleanupVerifications>;
    try {
      if (!body || Array.isArray(body) || Object.keys(body).length !== 1)
        throw new Error();
      requests = privateCleanupVerifications(body.operations);
    } catch {
      throw new NotFoundException();
    }
    return { proofs: await this.verifier.verifyMany(requests) };
  }
  @Post(':operation/verify')
  @HttpCode(200)
  verify(
    @Param('operation') operation: string,
    @Body() body: Record<string, unknown>,
  ) {
    const uuid =
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    if (
      !uuid.test(operation) ||
      !body ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof body.verificationId !== 'string' ||
      !uuid.test(body.verificationId)
    )
      throw new NotFoundException();
    return this.verifier.verify(operation, body.verificationId);
  }
}
