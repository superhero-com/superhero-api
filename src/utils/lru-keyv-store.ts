import { LRUCache } from 'lru-cache';

export function createLruKeyvStore(options: { max: number; maxSize: number }) {
  const lru = new LRUCache<string, string>({
    ...options,
    sizeCalculation: (value) => value.length,
  });

  return {
    get: (key: string) => lru.get(key),
    // Keyv passes a numeric ttl as the third argument, which lru-cache >= 11.3
    // throws on and Keyv swallows. Keyv stores the expiry with the value anyway.
    set: (key: string, value: string) => {
      lru.set(key, value);
    },
    delete: (key: string) => lru.delete(key),
    clear: () => lru.clear(),
  };
}
