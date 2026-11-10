import {
  createConcurrencyLimiter,
  mapWithConcurrency,
} from './concurrency.util';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('mapWithConcurrency', () => {
  it('returns [] for an empty input without invoking the mapper', async () => {
    const mapper = jest.fn();
    const result = await mapWithConcurrency([], 5, mapper);

    expect(result).toEqual([]);
    expect(mapper).not.toHaveBeenCalled();
  });

  it('preserves result order regardless of completion order', async () => {
    const delays = [30, 10, 20, 0];
    const result = await mapWithConcurrency(
      delays,
      4,
      (delay, index) =>
        new Promise<number>((resolve) =>
          setTimeout(() => resolve(index), delay),
        ),
    );

    expect(result).toEqual([0, 1, 2, 3]);
  });

  it('never runs more than `concurrency` mappers at once', async () => {
    let active = 0;
    let maxActive = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
      },
    );

    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('clamps concurrency to the item count', async () => {
    let maxActive = 0;
    let active = 0;

    await mapWithConcurrency([1, 2], 10, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe('createConcurrencyLimiter', () => {
  it('runs at most `limit` tasks across callers, in arrival order', async () => {
    const run = createConcurrencyLimiter(2);
    const started: string[] = [];
    const finish: Record<string, () => void> = {};
    const task = (name: string) => () => {
      started.push(name);
      return new Promise<void>((resolve) => (finish[name] = resolve));
    };

    const runs = ['a', 'b', 'c', 'd'].map((name) => run(task(name)));
    await flush();
    expect(started).toEqual(['a', 'b']);

    finish.b();
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);

    // Arriving after a slot was handed over, it still queues behind d.
    runs.push(run(task('e')));
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);

    finish.a();
    await flush();
    expect(started).toEqual(['a', 'b', 'c', 'd']);

    finish.c();
    await flush();
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e']);

    finish.d();
    finish.e();
    await Promise.all(runs);
  });

  it('frees the slot when a task rejects or throws', async () => {
    const run = createConcurrencyLimiter(1);

    await expect(run(() => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(
      run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    await expect(run(async () => 'ok')).resolves.toBe('ok');
  });
});
