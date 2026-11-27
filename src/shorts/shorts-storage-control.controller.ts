import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpCode,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  Optional,
  Param,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ShortsService } from './shorts.service';
import { ShortsPinTransfersService } from './shorts-pin-transfers.service';
import { shortsStorageScope } from './shorts-runtime-scope';
import { sourceKey } from './hls-protocol/hls-package';

/** Shared service authentication; each controller keeps its own enablement gate. */
export async function authenticateStorageControl(
  context: ExecutionContext,
  keyFile: string,
) {
  const request = context.switchToHttp().getRequest();
  const authorization = request.headers.authorization;
  if (
    request.headers.origin ||
    typeof authorization !== 'string' ||
    !/^Bearer [a-f0-9]{64}$/.test(authorization)
  )
    throw new UnauthorizedException();
  const key = (
    await readFile(keyFile, {
      encoding: 'utf8',
      signal: AbortSignal.timeout(5000),
    })
  ).trim();
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new ServiceUnavailableException('Storage control unavailable');
  if (!timingSafeEqual(Buffer.from(authorization.slice(7)), Buffer.from(key)))
    throw new UnauthorizedException();
  return true;
}

@Injectable()
export class ShortsStorageControlGuard implements CanActivate {
  private readonly enabled = process.env.SHORTS_IPFS_EXPIRING_WRITES === 'true';
  private readonly keyFile = process.env.SHORTS_STORAGE_CONTROL_TOKEN_FILE;
  constructor() {
    if (this.enabled && (!this.keyFile || !isAbsolute(this.keyFile)))
      throw new Error(
        'Expiring storage requires an absolute SHORTS_STORAGE_CONTROL_TOKEN_FILE',
      );
  }
  async canActivate(context: ExecutionContext) {
    if (!this.enabled) throw new NotFoundException();
    return authenticateStorageControl(context, this.keyFile!);
  }
}

/** Service-only write receipts. These routes never publish a Short or select delivery. */
@Controller('shorts/internal/storage')
@UseGuards(ShortsStorageControlGuard)
export class ShortsStorageControlController implements OnModuleDestroy {
  private stopped = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly shorts: ShortsService,
    @Optional() private readonly transfers?: ShortsPinTransfersService,
  ) {}
  private async run<T>(work: () => Promise<T>) {
    if (this.stopped || !this.transfers || this.pending.size >= 8)
      throw new ServiceUnavailableException('Storage control unavailable');
    const operation = work();
    this.pending.add(operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(operation);
    }
  }
  private input(id: string, body: Record<string, any>, keys: string[]) {
    if (
      !/^[a-zA-Z0-9-]{1,80}$/.test(id) ||
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body.sourceKey !== 'string' ||
      typeof body.operationId !== 'string' ||
      Buffer.byteLength(JSON.stringify(body)) > 4096 ||
      Object.keys(body).some((key) => !keys.includes(key)) ||
      !/^[a-f0-9]{64}$/.test(body.sourceKey) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        body.operationId,
      )
    )
      throw new NotFoundException();
  }
  @Post(':id/pins')
  @HttpCode(200)
  begin(@Param('id') id: string, @Body() body: Record<string, any>) {
    return this.run(async () => {
      this.input(id, body, ['operationId', 'sourceKey', 'generation', 'cid']);
      if (
        typeof body.cid !== 'string' ||
        (body.generation !== undefined &&
          (typeof body.generation !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(body.generation)))
      )
        throw new NotFoundException();
      const descriptor =
        body.generation && body.generation !== id
          ? await this.shorts.playbackGeneration(id, body.generation)
          : await this.shorts.playbackDescriptor(id);
      if (
        sourceKey(descriptor) !== body.sourceKey ||
        [
          descriptor.cid,
          descriptor.derivatives?.cid,
          descriptor.derivatives?.assetsCid,
        ].includes(body.cid)
      )
        throw new NotFoundException();
      return this.transfers!.begin(
        shortsStorageScope(this.shorts.chain),
        { cid: body.cid, jobId: id, purpose: 'hls', sourceKey: body.sourceKey },
        body.operationId,
      );
    });
  }
  @Post(':id/pins/bind')
  @HttpCode(200)
  bind(@Param('id') id: string, @Body() body: Record<string, any>) {
    return this.run(async () => {
      this.input(id, body, ['operationId', 'sourceKey', 'peerId', 'epoch']);
      if (
        typeof body.peerId !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,120}$/.test(body.peerId) ||
        typeof body.epoch !== 'string' ||
        !/^[a-f0-9]{64}$/.test(body.epoch)
      )
        throw new NotFoundException();
      const pin = await this.transfers!.get(body.operationId),
        scope = shortsStorageScope(this.shorts.chain);
      if (
        !pin ||
        pin.network !== scope.network ||
        pin.contract !== scope.contract ||
        pin.jobId !== id ||
        pin.purpose !== 'hls' ||
        pin.sourceKey !== body.sourceKey
      )
        throw new NotFoundException();
      return this.transfers!.bind(pin.operationId, {
        peerId: body.peerId,
        epoch: body.epoch,
      });
    });
  }
  @Post(':id/pins/finish')
  @HttpCode(200)
  finish(@Param('id') id: string, @Body() body: Record<string, any>) {
    return this.run(async () => {
      this.input(id, body, ['operationId', 'sourceKey', 'outcome', 'receipt']);
      const pin = await this.transfers!.get(body.operationId),
        scope = shortsStorageScope(this.shorts.chain);
      if (
        !pin ||
        pin.network !== scope.network ||
        pin.contract !== scope.contract ||
        pin.jobId !== id ||
        pin.purpose !== 'hls' ||
        pin.sourceKey !== body.sourceKey ||
        !['pinned', 'rejected', 'uncertain'].includes(body.outcome)
      )
        throw new NotFoundException();
      // Recording an outcome remains possible after withdrawal. It does not
      // authorize a metadata acknowledgement or resume an interrupted upload.
      if (
        body.outcome === 'pinned' &&
        (body.receipt?.version !== 1 ||
          body.receipt.cid !== pin.cid ||
          body.receipt.operation !== pin.operationId ||
          body.receipt.expires !== pin.expires ||
          body.receipt.status !== 'pinned' ||
          !pin.storage ||
          body.receipt.epoch !== pin.storage.epoch)
      )
        throw new NotFoundException();
      return this.transfers!.finish(pin.operationId, body.outcome);
    });
  }
  async onModuleDestroy() {
    this.stopped = true;
    await Promise.allSettled([...this.pending]);
  }
}
