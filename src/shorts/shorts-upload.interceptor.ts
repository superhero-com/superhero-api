import {
  CallHandler,
  BadRequestException,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import { lastValueFrom, Observable, of } from 'rxjs';
import { ShortsAuthService } from './shorts-auth.service';
import {
  ShortsUploadAdmissionService,
  UploadReservation,
} from './shorts-upload-admission.service';
import {
  SHORTS_UPLOAD_SIGNAL,
  ShortsUploadRequest,
} from './shorts-upload-context';

function setting(name: string, fallback: number, min: number, max: number) {
  const value =
    process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

/** Reserve bounded upload capacity before multipart parsing or video preparation. */
@Injectable()
export class ShortsUploadInterceptor
  implements NestInterceptor, OnModuleDestroy
{
  private readonly capacity = setting('SHORTS_CONCURRENT_UPLOADS', 2, 1, 8);
  private readonly bodyTimeout = setting(
    'SHORTS_UPLOAD_BODY_TIMEOUT_MS',
    120000,
    1000,
    300000,
  );
  private readonly actors = new Set<string>();
  private readonly active = new Map<Request, Promise<void>>();
  private readonly controllers = new Map<Request, AbortController>();
  private readonly operationTimeout = setting(
    'SHORTS_UPLOAD_OPERATION_TIMEOUT_MS',
    180000,
    1000,
    600000,
  );
  private stopped = false;

  constructor(
    private readonly auth: ShortsAuthService,
    @Optional() private readonly admission?: ShortsUploadAdmissionService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<ShortsUploadRequest>();
    const actor = await this.auth.authenticate(request.headers.authorization);
    if (
      this.auth.shared &&
      ['upload', 'uploadPart'].includes(context.getHandler().name)
    )
      throw new BadRequestException(
        'Upload video directly to storage using a signed upload permission. Refresh Studio to continue.',
      );
    if (this.auth.shared && !this.admission)
      throw new ServiceUnavailableException(
        'Shared upload admission unavailable',
      );
    if (this.stopped)
      throw new ServiceUnavailableException(
        'Shorts is restarting. Please try again shortly.',
      );
    if (this.actors.has(actor))
      throw new HttpException(
        'Another upload is in progress. Please wait for it to finish.',
        429,
      );
    if (this.active.size >= this.capacity)
      throw new ServiceUnavailableException(
        'Uploads are busy. Please try again shortly.',
      );
    this.actors.add(actor);
    const controller = new AbortController();
    this.controllers.set(request, controller);
    request[SHORTS_UPLOAD_SIGNAL] = controller.signal;
    let settled: () => void;
    this.active.set(
      request,
      new Promise<void>((resolve) => {
        settled = resolve;
      }),
    );
    let timer: NodeJS.Timeout | undefined;
    let reservation: UploadReservation | undefined;
    const interrupted = () =>
      controller.abort(
        new ServiceUnavailableException(
          'Upload interrupted. Please resume your upload.',
        ),
      );
    const abortBody = () => {
      if (!request.complete) request.destroy(new Error('Upload interrupted'));
    };
    controller.signal.addEventListener('abort', abortBody, { once: true });
    request.once('aborted', interrupted);
    const deadline = setTimeout(interrupted, this.operationTimeout);
    deadline.unref();
    const bodyComplete = () => clearTimeout(timer);
    if (!request.complete && request.is('multipart/form-data')) {
      timer = setTimeout(() => {
        interrupted();
      }, this.bodyTimeout);
      timer.unref();
      request.once('end', bodyComplete);
    }
    try {
      if (this.admission) {
        reservation = await this.admission.acquire(actor);
        reservation.signal.addEventListener('abort', interrupted, {
          once: true,
        });
        if (reservation.signal.aborted) interrupted();
      }
      if (request.destroyed && !request.complete) interrupted();
      controller.signal.throwIfAborted();
      // Keep this subscription until parsing AND the controller's Promise settle.
      // A disconnected viewer must not release capacity while work still runs.
      const result = await lastValueFrom(next.handle());
      controller.signal.throwIfAborted();
      return of(result);
    } finally {
      clearTimeout(timer);
      clearTimeout(deadline);
      request.removeListener('end', bodyComplete);
      request.removeListener('aborted', interrupted);
      controller.signal.removeEventListener('abort', abortBody);
      reservation?.signal.removeEventListener('abort', interrupted);
      // Do not release while an S3/metadata Promise is still settling. If an
      // acknowledgement was lost, immutable upload records make retry safe.
      await reservation?.release().catch(() => {});
      this.actors.delete(actor);
      this.active.delete(request);
      this.controllers.delete(request);
      settled!();
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    for (const controller of this.controllers.values())
      controller.abort(new ServiceUnavailableException('Shorts is restarting'));
    await Promise.all(this.active.values());
  }
}
