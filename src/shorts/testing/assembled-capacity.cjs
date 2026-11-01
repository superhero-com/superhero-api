// Opt-in owned-fixture HTTP capacity observations, not a launch SLA/soak test.
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { join, isAbsolute } = require('node:path');
const { writeFile } = require('node:fs/promises');

exports.assembledCapacity = async (t, f, { repo, edgeBase, metrics, startWorker }) => {
  const { runPlaybackLoad } = await import(pathToFileURL(join(repo, 'test/load-playback.mjs')).href);
  const catalog = await f.catalog(3);
  // Distinct IDs run real preparation. They share one synthetic source and are
  // not independent uploads or representative production media.
  const urls = catalog.ids.slice(1, 4).map(id => edgeBase + `/videos/${id}/playback`);
  const observations = [];
  async function phase(name, workload) {
    const before = await metrics();
    let stopped = false, samples = 0, maxRss = before.rss, maxActive = 0, maxWaiting = 0, sampleError;
    const poller = (async () => {
      while (!stopped) {
        try {
          const value = await metrics(); samples++; maxRss = Math.max(maxRss, value.rss);
          maxActive = Math.max(maxActive, value.preparation.active);
          maxWaiting = Math.max(maxWaiting, value.preparation.wait + value.preparation.delayed);
        } catch (error) { sampleError = error; break; }
        await f.pause(250);
      }
    })();
    let result;
    try { result = await runPlaybackLoad({ urls, paceMs: 1000, requestTimeoutMs: 10000, ...workload }); }
    finally { stopped = true; await poller; }
    if (sampleError) throw sampleError;
    const after = await metrics();
    const value = { name, result, before, after, sampled: { samples, maxRss, maxActive, maxWaiting } };
    observations.push(value);
    assert.ok(Number.isFinite(maxRss));
    assert.equal(after.preparation.failed, 0);
    assert.equal(after.cache.reserved, 0);
    assert.equal(after.cache.downloads, 0);
    assert.equal(after.disk.admissionOpen, true);
    return result;
  }
  try {
    // Use actual local IP identity and unchanged edge/session limits. No forged
    // viewer addresses or budget resets to make throughput appear higher.
    await f.pause(5000);
    const queued = await phase('queued-without-worker', { visits: 3, concurrency: 2, paceMs: 0 });
    assert.equal(queued.preparationResponses, 3);
    assert.equal(queued.failures.preparation_required, 3);
    await startWorker();
    const cold = await phase('cold', { visits: 3, concurrency: 2, prepareTimeoutMs: 30000 });
    assert.equal(cold.completed, 3, JSON.stringify(cold.failures));
    await f.pause(2000);
    const warm = await phase('warm', { visits: 12, concurrency: 3 });
    assert.equal(warm.completed, 12, JSON.stringify(warm.failures));
    assert.ok(warm.stages.segment.cacheHits > 0);
    const burst = await phase('shared-ip-burst', { visits: 80, concurrency: 16, paceMs: 0 });
    assert.ok(burst.failures.http_429 > 0, 'the unchanged edge must apply backpressure');
    assert.deepEqual(Object.keys(burst.failures), ['http_429']);
    await f.pause(5000);
    const recovered = await phase('recovered', { visits: 3, concurrency: 1 });
    assert.equal(recovered.completed, 3, JSON.stringify(recovered.failures));
    t.diagnostic(JSON.stringify(observations.map(value => ({ phase: value.name, completed: value.result.completed,
      failed: value.result.failed, failures: value.result.failures, durationMs: value.result.durationMs,
      firstSegment: value.result.sessionToFirstSegmentComplete, sampled: value.sampled }))));
  } finally {
    const report = { scope: 'owned loopback HTTP fixture; one client IP; synthetic shared source; no browser decoder or upload load', observations };
    const output = process.env.SHORTS_TEST_CAPACITY_OUTPUT;
    if (output) {
      assert.ok(isAbsolute(output), 'capacity evidence output must be an absolute private path');
      await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    }
    await catalog.close();
  }
};
