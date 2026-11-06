import WebSocket from 'ws';

// Prod (node:20) has no global WebSocket, so the relay services fall back to
// `ws`; rerun their relay specs on it, since newer Node only exercises its own.
delete (globalThis as { WebSocket?: unknown }).WebSocket;
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./relay-writer.service.spec');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./relay-subscriber.service.spec');

it('runs the relay specs above on the ws package', () => {
  expect(globalThis.WebSocket).toBe(WebSocket);
});
