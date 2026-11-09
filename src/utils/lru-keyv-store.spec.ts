import { Keyv } from 'keyv';
import { createLruKeyvStore } from './lru-keyv-store';

describe('createLruKeyvStore', () => {
  const keyvWithMaxSize = (maxSize: number) =>
    new Keyv({ store: createLruKeyvStore({ max: 100, maxSize }) });

  afterEach(() => jest.restoreAllMocks());

  it('keeps a value written with a numeric ttl until it expires', async () => {
    const keyv = keyvWithMaxSize(1024);
    const now = Date.now();

    await expect(keyv.set('key', { a: 1 }, 60_000)).resolves.toBe(true);
    await expect(keyv.get('key')).resolves.toEqual({ a: 1 });

    jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await expect(keyv.get('key')).resolves.toBeUndefined();
  });

  it('evicts the oldest entries once the byte limit is reached', async () => {
    const keyv = keyvWithMaxSize(100);

    await keyv.set('first', 'a'.repeat(40), 60_000);
    await keyv.set('second', 'b'.repeat(40), 60_000);
    await keyv.set('third', 'c'.repeat(40), 60_000);

    await expect(keyv.get('first')).resolves.toBeUndefined();
    await expect(keyv.get('third')).resolves.toBe('c'.repeat(40));
  });

  it('skips an entry larger than the byte limit without losing others', async () => {
    const keyv = keyvWithMaxSize(100);

    await keyv.set('small', 'a'.repeat(30), 60_000);
    await keyv.set('huge', 'b'.repeat(500), 60_000);

    await expect(keyv.get('huge')).resolves.toBeUndefined();
    await expect(keyv.get('small')).resolves.toBe('a'.repeat(30));
  });
});
