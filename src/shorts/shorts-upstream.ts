/** Bound decoded response bytes before buffering or parsing an upstream body. */
export async function readShortsResponse(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  const cancel = () => {
    // Cancellation must not hold admission while an upstream closes its socket.
    void reader?.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 67108864)
      throw new Error('Invalid upstream response limit');
    const declared = response.headers.get('content-length');
    const encoded = response.headers.get('content-encoding');
    if (
      declared !== null &&
      (!/^[0-9]+$/.test(declared) ||
        ((!encoded || encoded === 'identity') && Number(declared) > maxBytes))
    )
      throw new Error('Upstream response too large or invalid');
    // A fixed byte budget also bounds overhead from arbitrarily tiny chunks.
    const buffer = Buffer.alloc(maxBytes);
    let length = 0;
    if (reader)
      while (true) {
        const part = await reader.read();
        signal?.throwIfAborted();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > maxBytes) throw new Error('Upstream response too large');
        buffer.set(part.value, length - part.value.byteLength);
      }
    return buffer.subarray(0, length);
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
    reader?.releaseLock();
  }
}

export async function readShortsJson(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
) {
  const bytes = await readShortsResponse(response, maxBytes, signal);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    // Parser errors can quote untrusted provider data or reflected credentials.
    throw new Error('Invalid upstream JSON response');
  }
}

/** Call when only the status matters; never leave an unread response consuming a connection. */
export function discardShortsResponse(response: Response) {
  void response.body?.cancel().catch(() => {});
}
