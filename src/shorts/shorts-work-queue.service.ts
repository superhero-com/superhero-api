import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';

interface PendingOperation {
  run(): Promise<void>;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
  detach?(): void;
}

function limit(name: string, fallback: number, min: number, max: number) {
  const value =
    process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

/** Bounded FIFO admission for mutations of the single-owner Shorts snapshot. */
@Injectable()
export class ShortsWorkQueueService implements OnModuleDestroy {
  private readonly capacity = limit('SHORTS_MAX_PENDING_OPERATIONS', 8, 1, 64);
  private readonly waitMs = limit(
    'SHORTS_OPERATION_WAIT_MS',
    30000,
    100,
    60000,
  );
  private readonly pending: PendingOperation[] = [];
  private active?: Promise<void>;
  private stopped = false;

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.stopped)
      return Promise.reject(
        new ServiceUnavailableException(
          'Shorts is restarting. Please try again shortly.',
        ),
      );
    if (this.pending.length + Number(!!this.active) >= this.capacity)
      return Promise.reject(
        new ServiceUnavailableException(
          'Shorts is busy. Please try again shortly.',
        ),
      );
    return new Promise<T>((resolve, reject) => {
      const job: PendingOperation = {
        reject,
        run: async () => {
          try {
            signal?.throwIfAborted();
            resolve(await operation());
          } catch (error) {
            reject(error);
          }
        },
      };
      const abort = () => {
        const index = this.pending.indexOf(job);
        if (index === -1) return; // Started work must drain; never release it early.
        this.pending.splice(index, 1);
        clearTimeout(job.timer);
        job.detach();
        reject(signal!.reason);
      };
      job.detach = () => signal?.removeEventListener('abort', abort);
      signal?.addEventListener('abort', abort, { once: true });
      job.timer = setTimeout(() => {
        const index = this.pending.indexOf(job);
        if (index === -1) return;
        this.pending.splice(index, 1);
        job.detach();
        reject(
          new ServiceUnavailableException(
            'Shorts is busy. This request did not start. Please try again.',
          ),
        );
      }, this.waitMs);
      job.timer.unref();
      this.pending.push(job);
      this.startNext();
    });
  }

  private startNext() {
    if (this.active || this.stopped) return;
    const job = this.pending.shift();
    if (!job) return;
    clearTimeout(job.timer);
    job.detach();
    // Assign active before invoking user code, including synchronous callbacks.
    this.active = Promise.resolve()
      .then(() => job.run())
      .finally(() => {
        this.active = undefined;
        this.startNext();
      });
  }

  async onModuleDestroy() {
    this.stopped = true;
    for (const job of this.pending.splice(0)) {
      clearTimeout(job.timer);
      job.detach();
      job.reject(
        new ServiceUnavailableException(
          'Shorts is restarting. This request did not start.',
        ),
      );
    }
    // Never abandon a started mutation or allow a second one to overlap it.
    // In particular, a slow transaction submission must not be timed out and retried.
    await this.active;
  }
}
