import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export function shortsStreamConnection() {
  const origin = process.env.SHORTS_STREAM_INTERNAL_URL?.replace(/\/$/, '');
  if (!origin) return undefined;
  const url = new URL(origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(
        local &&
        url.protocol === 'http:' &&
        process.env.NODE_ENV !== 'production'
      ))
  )
    throw new Error(
      'SHORTS_STREAM_INTERNAL_URL requires an HTTPS origin (HTTP only for local development)',
    );
  const keyFile = process.env.SHORTS_STREAM_KEY_FILE;
  if (!keyFile || !isAbsolute(keyFile))
    throw new Error(
      'SHORTS_STREAM_KEY_FILE must be an absolute server-only key path',
    );
  return { origin: url.origin, keyFile };
}

export async function shortsStreamKey(file: string, signal: AbortSignal) {
  const key = (await readFile(file, { encoding: 'utf8', signal })).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid streaming key');
  return key;
}
