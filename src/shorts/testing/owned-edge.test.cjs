const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ownedEdgeName, startOwnedEdge } = require('./owned-edge.cjs');
const exec = promisify(execFile);

test('edge fixture rejects names outside its owned UUID namespace', () => {
  for (const name of ['streaming', 'sh-shorts-edge-', 'sh-shorts-edge-../../other'])
    assert.throws(() => ownedEdgeName(name));
});

test('edge creation collision preserves the existing container; successful cleanup removes only the new one', {
  skip: !process.env.SHORTS_TEST_EDGE_FIXTURE_IMAGE,
}, async t => {
  const image = process.env.SHORTS_TEST_EDGE_FIXTURE_IMAGE;
  const existing = `sh-shorts-edge-${randomUUID()}`, fresh = `sh-shorts-edge-${randomUUID()}`;
  const args = ['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--entrypoint', 'sleep', image, '60'];
  let existingCreated = false, cleanup;
  t.after(async () => {
    await cleanup?.();
    if (existingCreated) await exec('docker', ['rm', '-f', existing]);
  });
  const { stdout: id } = await exec('docker', ['create', '--pull=never', '--name', existing, ...args]);
  existingCreated = true;
  await assert.rejects(async () => { cleanup = await startOwnedEdge(exec, existing, args); });
  assert.equal(cleanup, undefined);
  assert.equal((await exec('docker', ['inspect', '--format', '{{.Id}}', existing])).stdout.trim(), id.trim());
  cleanup = await startOwnedEdge(exec, fresh, args);
  assert.equal((await exec('docker', ['inspect', '--format', '{{.State.Running}}', fresh])).stdout.trim(), 'true');
  await cleanup(); cleanup = undefined;
  await assert.rejects(exec('docker', ['inspect', fresh]));
  assert.equal((await exec('docker', ['inspect', '--format', '{{.Id}}', existing])).stdout.trim(), id.trim());
});
