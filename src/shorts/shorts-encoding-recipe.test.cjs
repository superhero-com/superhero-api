const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodingRecipe, recordEncodingCommand, encodingFingerprint } = require('./shorts-encoding-recipe');

const versions = { ffmpeg: 'ffmpeg version fixture\nlibavcodec 1\n', ffprobe: 'ffprobe version fixture\nlibavformat 1\n' };
const recipe = (directory, source) => {
  const value = encodingRecipe(versions);
  recordEncodingCommand(value, 'ffmpeg', ['-i', source, '-vf', 'scale=1080:1920,fps=60000/1001',
    '-crf', '20', '-maxrate', '12M', '-bufsize', '24M', directory + '/video-1080.mp4'], source, directory);
  return value;
};

test('encoding identity keeps every effective argument while excluding ephemeral working paths', () => {
  const value = recipe('/private/tmp/attempt-a', '/private/tmp/upload-a/original');
  assert.deepEqual(value.commands[0].args, ['-i', '@original', '-vf', 'scale=1080:1920,fps=60000/1001',
    '-crf', '20', '-maxrate', '12M', '-bufsize', '24M', '@work/video-1080.mp4']);
  assert.deepEqual(value, recipe('/worker/scratch/attempt-b', '/worker/upload-b/original'));
  const fingerprint = encodingFingerprint(value);
  for (const [flag, replacement] of [['-vf', 'scale=1080:1920,fps=30/1'], ['-crf', '18'], ['-maxrate', '8M'], ['-bufsize', '16M']]) {
    const changed = structuredClone(value), args = changed.commands[0].args;
    args[args.indexOf(flag) + 1] = replacement;
    assert.notEqual(encodingFingerprint(changed), fingerprint, flag);
  }
  for (const program of ['ffmpeg', 'ffprobe']) {
    const changed = encodingRecipe({ ...versions, [program]: versions[program] + 'different build/library\n' });
    changed.commands = value.commands;
    assert.notEqual(encodingFingerprint(changed), fingerprint, program);
  }
  const changed = structuredClone(value); changed.policy = '0'.repeat(64);
  assert.notEqual(encodingFingerprint(changed), fingerprint);
  assert.doesNotMatch(JSON.stringify(value), /private\/tmp|upload-a|libavcodec/);
});

test('toolchain identity rejects absent, oversized and malformed version responses', () => {
  for (const output of ['', 'unexpected command', 'ffmpeg version bad\0', 'ffmpeg version ' + 'x'.repeat(65536)])
    assert.throws(() => encodingRecipe({ ...versions, ffmpeg: output }));
});
