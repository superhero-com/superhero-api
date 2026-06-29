import {
  __resetTgrMetricsForTests,
  getTgrMetricsSnapshot,
  incrementAckTimeout,
  incrementPublishFailed,
  incrementPublishOk,
  incrementRelayReconnect,
  resetTgrCounters,
  setRelaySubscriberConnected,
  setRelayWriterConnected,
} from '../tgr-metrics';

describe('tgr-metrics (in-memory counters)', () => {
  beforeEach(() => {
    __resetTgrMetricsForTests();
  });

  it('each setter mutates the right field; snapshot returns them', () => {
    incrementPublishOk();
    incrementPublishOk();
    incrementPublishFailed();
    incrementAckTimeout();
    incrementRelayReconnect();

    const snap = getTgrMetricsSnapshot();
    expect(snap.publishOk).toBe(2);
    expect(snap.publishFailed).toBe(1);
    expect(snap.ackTimeouts).toBe(1);
    expect(snap.relayReconnects).toBe(1);
  });

  it('incrementPublishFailed(true) also bumps ackTimeouts', () => {
    incrementPublishFailed(true);
    const snap = getTgrMetricsSnapshot();
    expect(snap.publishFailed).toBe(1);
    expect(snap.ackTimeouts).toBe(1);
  });

  it('connection flags + edge timestamps update on transitions', () => {
    const before = Date.now();
    setRelayWriterConnected(true);
    let snap = getTgrMetricsSnapshot();
    expect(snap.relayWriterConnected).toBe(true);
    expect(snap.lastRelayConnectAt).toBeGreaterThanOrEqual(before);
    expect(snap.lastRelayDisconnectAt).toBeNull();

    setRelayWriterConnected(false);
    snap = getTgrMetricsSnapshot();
    expect(snap.relayWriterConnected).toBe(false);
    expect(snap.lastRelayDisconnectAt).toBeGreaterThanOrEqual(before);

    setRelaySubscriberConnected(true);
    expect(getTgrMetricsSnapshot().relaySubscriberConnected).toBe(true);
  });

  it('idempotent flag set does not re-stamp the disconnect timestamp', () => {
    setRelayWriterConnected(true);
    setRelayWriterConnected(false);
    const first = getTgrMetricsSnapshot().lastRelayDisconnectAt;
    // Setting false again (no edge) must not move the timestamp.
    setRelayWriterConnected(false);
    expect(getTgrMetricsSnapshot().lastRelayDisconnectAt).toBe(first);
  });

  it('resetTgrCounters zeroes rate counters but LEAVES flags + timestamps', () => {
    incrementPublishOk();
    incrementPublishFailed(true);
    incrementRelayReconnect();
    setRelayWriterConnected(true);
    setRelayWriterConnected(false);

    const disconnectAt = getTgrMetricsSnapshot().lastRelayDisconnectAt;

    resetTgrCounters();

    const snap = getTgrMetricsSnapshot();
    expect(snap.publishOk).toBe(0);
    expect(snap.publishFailed).toBe(0);
    expect(snap.ackTimeouts).toBe(0);
    expect(snap.relayReconnects).toBe(0);
    // Flags + timestamps survive a counter reset.
    expect(snap.relayWriterConnected).toBe(false);
    expect(snap.lastRelayDisconnectAt).toBe(disconnectAt);
  });
});
