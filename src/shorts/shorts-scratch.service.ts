import {
  Inject,
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { mkdir, statfs } from 'node:fs/promises';
import {
  SHORTS_SCRATCH_CONFIG,
  ShortsScratchConfig,
} from './shorts-scratch.config';

export class ScratchCapacityError extends ServiceUnavailableException {
  constructor() {
    super('Media disk capacity unavailable');
  }
}

@Injectable()
export class ShortsScratchProbeService {
  read(path: string) {
    return statfs(path, { bigint: true });
  }
}

type Sample = Awaited<ReturnType<ShortsScratchProbeService['read']>>;
type Reservation = { bytes: bigint; inodes: bigint; abort: AbortController };

/** Process-local reservations on an instance-owned volume. Host quotas remain necessary. */
@Injectable()
export class ShortsScratchService implements OnModuleInit, OnModuleDestroy {
  private stopped = false;
  private reading?: Promise<Sample>;
  private admission = Promise.resolve();
  private waiting = 0;
  private reservations = new Set<Reservation>();
  private timer?: NodeJS.Timeout;
  private monitoring = false;
  constructor(
    @Inject(SHORTS_SCRATCH_CONFIG) private readonly config: ShortsScratchConfig,
    private readonly probe: ShortsScratchProbeService,
  ) {}

  get directory() {
    return this.config.directory;
  }
  async onModuleInit() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  async check(signal?: AbortSignal) {
    const lease = await this.reserve(192 * 1048576, 16, signal);
    lease.release();
  }

  private async sample() {
    if (this.stopped) throw new ScratchCapacityError();
    // A timed-out statfs cannot be cancelled. Keep that one call in flight rather
    // than growing an abandoned filesystem queue while the mount is unavailable.
    if (!this.reading) {
      const task = Promise.resolve().then(() =>
        this.probe.read(this.config.directory),
      );
      this.reading = task;
      void task
        .finally(() => {
          if (this.reading === task) this.reading = undefined;
        })
        .catch(() => undefined);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const value = await Promise.race([
        this.reading,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ScratchCapacityError()), 1000);
        }),
      ]);
      for (const key of [
        'bsize',
        'blocks',
        'bfree',
        'bavail',
        'files',
        'ffree',
      ] as const)
        if (typeof value[key] !== 'bigint' || value[key] < 0n)
          throw new ScratchCapacityError();
      if (
        this.stopped ||
        !value.bsize ||
        !value.blocks ||
        !value.files ||
        value.bavail > value.bfree ||
        value.bfree > value.blocks ||
        value.ffree > value.files
      )
        throw new ScratchCapacityError();
      return value;
    } catch {
      throw new ScratchCapacityError();
    } finally {
      clearTimeout(timer);
    }
  }
  private counters() {
    let bytes = 0n,
      inodes = 0n;
    for (const held of this.reservations) {
      bytes += held.bytes;
      inodes += held.inodes;
    }
    return { bytes, inodes };
  }
  private limits(sample: Sample) {
    const percent = BigInt(100 - this.config.maxUsedPercent);
    const max = (a: bigint, b: bigint) => (a > b ? a : b);
    return {
      bytes: max(
        BigInt(this.config.minFreeBytes),
        (sample.blocks * sample.bsize * percent + 99n) / 100n,
      ),
      inodes: max(
        BigInt(this.config.minFreeInodes),
        (sample.files * percent + 99n) / 100n,
      ),
    };
  }
  private fits(sample: Sample, bytes = 0n, inodes = 0n) {
    const floor = this.limits(sample);
    return (
      sample.bavail * sample.bsize >= floor.bytes + bytes &&
      sample.ffree >= floor.inodes + inodes
    );
  }
  async assertHeadroom() {
    if (!this.fits(await this.sample())) throw new ScratchCapacityError();
  }
  async snapshot() {
    try {
      const sample = await this.sample();
      const held = this.counters();
      return {
        observed: true,
        admissionOpen: this.fits(sample, held.bytes, held.inodes),
        totalBytes: String(sample.blocks * sample.bsize),
        availableBytes: String(sample.bavail * sample.bsize),
        totalInodes: String(sample.files),
        freeInodes: String(sample.ffree),
        reservedBytes: String(held.bytes),
        reservedInodes: String(held.inodes),
        reservations: this.reservations.size,
        minFreeBytes: String(this.limits(sample).bytes),
        minFreeInodes: String(this.limits(sample).inodes),
      };
    } catch {
      return {
        observed: false,
        admissionOpen: false,
        reservations: this.reservations.size,
      };
    }
  }
  async reserve(bytes: number, inodes: number, signal?: AbortSignal) {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > 256_000_000 ||
      !Number.isSafeInteger(inodes) ||
      inodes < 1 ||
      inodes > 128 ||
      this.waiting >= 64 ||
      this.reservations.size >= 1024 ||
      this.stopped
    )
      throw new ScratchCapacityError();
    this.waiting++;
    const task = this.admission.then(async () => {
      signal?.throwIfAborted();
      const sample = await this.sample(),
        held = this.counters();
      signal?.throwIfAborted();
      // Include allocation slack and retain the full reservation until cleanup.
      // Already-written bytes can therefore be counted twice; fail conservatively.
      const size = BigInt(bytes) + sample.bsize * BigInt(inodes);
      if (!this.fits(sample, held.bytes + size, held.inodes + BigInt(inodes)))
        throw new ScratchCapacityError();
      const reservation = {
        bytes: size,
        inodes: BigInt(inodes),
        abort: new AbortController(),
      };
      this.reservations.add(reservation);
      this.watch();
      return {
        signal: reservation.abort.signal,
        release: () => {
          this.reservations.delete(reservation);
          if (!this.reservations.size) {
            clearInterval(this.timer);
            this.timer = undefined;
          }
        },
      };
    });
    this.admission = task.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await task;
    } finally {
      this.waiting--;
    }
  }
  private watch() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.monitoring || this.stopped || !this.reservations.size) return;
      this.monitoring = true;
      void this.sample()
        .then((sample) => {
          if (!this.fits(sample)) throw new ScratchCapacityError();
        })
        .catch(() => {
          for (const held of this.reservations)
            held.abort.abort(new ScratchCapacityError());
        })
        .finally(() => {
          this.monitoring = false;
        });
    }, 250);
    this.timer.unref();
  }
  onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const held of this.reservations)
      held.abort.abort(new ScratchCapacityError());
  }
}
