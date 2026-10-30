import type { EventTemplate, Relay, VerifiedEvent } from 'nostr-tools';

/** Wait for the asynchronous NIP-42 challenge and its ACK before private reads. */
export async function authenticateRelay(
  relay: Relay,
  sign: (event: EventTemplate) => Promise<VerifiedEvent>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || !relay.connected) {
      throw new Error('Relay authentication unavailable or timed out');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        relay.auth(sign),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Relay authentication timed out')),
            remaining,
          );
        }),
      ]);
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('no challenge was received')
      ) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, remaining)),
    );
  }
}
