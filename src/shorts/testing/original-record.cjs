const { descriptor } = require('./hls-v3.json');

function originalRecord(id = descriptor.id, fields = {}) {
  const record = { ...structuredClone(descriptor), id, ...fields };
  record.derivatives.generation.job = id;
  return record;
}
function privateOriginalRecord(id, fields) {
  const record = originalRecord(id, fields);
  record.privateMedia = {
    version: 1, fence: record.derivatives.generation.fence,
    source: { processingProfile: record.derivatives.profile, bytes: record.bytes, sha256: record.original.sha256 },
  };
  return record;
}
function workerRecord(job) {
  const hash = job.input.sha256;
  const profile = 'original-h264-v1', cid = 'bafy' + 'a'.repeat(50);
  const files = ['video-1080.mp4', 'video-rescue.mp4', 'video.mp4', 'poster.jpg', 'manifest.json']
    .map(name => ({ name, bytes: 100, sha256: hash }));
  return { id: job.id, creator: job.creator, title: job.input.title, topic: job.input.topic, createdAt: 1,
    cid, bytes: job.input.bytes, duration: 3, files, moderation: 'pending', safety: { status: 'no_flags', sourceSha256: hash },
    original: { version: 1, sha256: hash, mediaType: 'video/mp4', importProfile: 'unixfs-file-v1-262144' },
    derivatives: { version: 1, cid: 'bafy' + 'b'.repeat(50), assetsCid: 'bafy' + 'e'.repeat(50), profile, fingerprint: hash, generation: { job: job.id, fence: String(job.fence) }, videos: [
      { name: 'video-1080.mp4', width: 1080, height: 1920, frameRate: '60000/1001' },
      { name: 'video-rescue.mp4', width: 144, height: 256, frameRate: '15000/1001' },
    ] },
    privateMedia: { version: 1, fence: String(job.fence), source: structuredClone(job.input),
      files: Object.fromEntries(files.map(file => [file.name, { bytes: file.bytes, sha256: hash, keyId: 'key1',
        key: `shorts-private-v1/${hash}/${job.id}/attempt/${job.fence}/${file.name.replaceAll('.', '-')}/key1/${hash}` }])) },
  };
}
module.exports = { originalRecord, privateOriginalRecord, workerRecord };
