const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runShortsMediaCommand: run } = require('./shorts-media-command');
const options = { timeout: 10000, maxBuffer: 1024 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, body = "setInterval(() => fs.appendFileSync(output, 'frame\\n'), 10);") {
  const directory = await mkdtemp(join(tmpdir(), 'shorts-media-command-'));
  const ready = join(directory, 'ready'), output = join(directory, 'partial'), script = join(directory, 'child.cjs');
  let pid;
  t.after(async () => {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(script, `const fs=require('node:fs'); const output=${JSON.stringify(output)};
    process.on('SIGTERM', () => {});
    fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    ${body}
  `);
  return {
    args: [script], ready,
    started: async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { pid = Number(await readFile(ready, 'utf8')); if (pid) return pid; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await pause(10);
      }
      assert.fail('Media child did not start');
    },
  };
}

test('cancellation settles only after a SIGTERM-resistant writer has exited', { timeout: 10000 }, async t => {
  const f = await fixture(t), controller = new AbortController();
  const work = run(process.execPath, f.args, { ...options, signal: controller.signal });
  const rejected = assert.rejects(work, error => error === controller.signal.reason || error.name === 'AbortError');
  const pid = await f.started();
  controller.abort(new Error('Encoding authority withdrawn'));
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'Scratch must not be released while the writer is alive');
});

test('deadline terminates a resistant child before rejecting', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const work = run(process.execPath, f.args, { ...options, timeout: 1000 });
  const rejected = assert.rejects(work, error => error.signal === 'SIGKILL');
  const pid = await f.started();
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('output overflow terminates the child before rejecting', { timeout: 10000 }, async t => {
  const f = await fixture(t, "setInterval(() => process.stdout.write(Buffer.alloc(2048)), 10);");
  const work = run(process.execPath, f.args, options);
  const rejected = assert.rejects(work, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  const pid = await f.started();
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('cancelled admission does not start a process, and missing programs settle', async t => {
  const f = await fixture(t), reason = new Error('Already cancelled');
  await assert.rejects(run(process.execPath, f.args, { ...options, signal: AbortSignal.abort(reason) }), error => error === reason);
  await assert.rejects(readFile(f.ready), { code: 'ENOENT' });
  await assert.rejects(run(join(tmpdir(), 'nonexistent-shorts-command'), [], options), { code: 'ENOENT' });
});

test('successful commands preserve text and bounded binary output', async () => {
  assert.deepEqual(await run(process.execPath, ['-e', "process.stdout.write('ready');process.stderr.write('note')"], options), { stdout: 'ready', stderr: 'note' });
  const binary = await run(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,128,255]))'], { ...options, encoding: 'buffer' });
  assert.deepEqual(binary.stdout, Buffer.from([0,128,255]));
  assert.deepEqual(binary.stderr, Buffer.alloc(0));
});
