import { mapWithConcurrency } from './concurrency.util';

describe('mapWithConcurrency', () => {
  it('returns [] for an empty input without invoking the mapper', async () => {
    const mapper = jest.fn();
    const result = await mapWithConcurrency([], 5, mapper);

    expect(result).toEqual([]);
    expect(mapper).not.toHaveBeenCalled();
  });

  it('preserves result order regardless of completion order', async () => {
    const delays = [30, 10, 20, 0];
    const result = await mapWithConcurrency(delays, 4, (delay, index) =>
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
