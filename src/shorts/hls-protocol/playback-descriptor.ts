// Playback wire protocol; mirrored by superhero-video-streaming with shared compatibility vectors.
export interface PlaybackDescriptor {
  id: string;
  /** Canonical legacy directory or exact original-file CID. */
  cid: string;
  /** Immutable published legacy directory, including when delivery uses its retained original. */
  canonical?: { version: 1; cid: string; bytes: number };
  network?: 'ae_uat' | 'ae_mainnet';
  contract?: string;
  bytes?: number;
  original?: {
    version: 1;
    sha256: string;
    mediaType: 'video/mp4' | 'video/quicktime';
    importProfile: 'unixfs-file-v1-262144';
  };
  derivatives?: {
    version: 1;
    cid: string;
    assetsCid: string;
    profile: 'original-h264-v1';
    fingerprint: string;
    generation: { job: string; fence: string };
    videos: {
      name: string;
      width: number;
      height: number;
      frameRate: string;
    }[];
  };
  files: { name: string; bytes: number; sha256: string }[];
}
export const cidPattern = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,118})$/;
export const sourceNames = [
  'video-1080.mp4',
  'video-720.mp4',
  'video-480.mp4',
  'video-360.mp4',
  'video-rescue.mp4',
  'audio-main.m4a',
  'audio-rescue.m4a',
  'video.mp4',
  'poster.jpg',
  'manifest.json',
  'captions.vtt',
];
export const derivativeLimit = 192 * 1048576;
export const assetNames = [
  'video.mp4',
  'poster.jpg',
  'manifest.json',
  'captions.vtt',
];
const sha = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validateDescriptor(
  value: PlaybackDescriptor,
  id = value?.id,
): PlaybackDescriptor {
  const original = value?.original,
    delivery = value?.derivatives;
  const adaptive = original !== undefined || delivery !== undefined;
  if (
    !value ||
    value.id !== id ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(value.id) ||
    !cidPattern.test(value.cid) ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > (adaptive ? 11 : 3) ||
    new Set(value.files.map((file) => file?.name)).size !==
      value.files.length ||
    value.files.some(
      (file) =>
        !file ||
        !(
          adaptive ? sourceNames : ['video.mp4', 'poster.jpg', 'captions.vtt']
        ).includes(file.name) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > 100000000 ||
        !sha(file.sha256),
    )
  )
    throw new Error('Invalid playback descriptor');
  if (value.canonical !== undefined) {
    const canonical = value.canonical;
    if (
      canonical?.version !== 1 ||
      typeof canonical.cid !== 'string' ||
      !cidPattern.test(canonical.cid) ||
      !Number.isSafeInteger(canonical.bytes) ||
      canonical.bytes < 1 ||
      canonical.bytes > 100000000 ||
      (adaptive ? canonical.cid === value.cid : canonical.cid !== value.cid)
    )
      throw new Error('Invalid canonical legacy publication');
  }
  if (!adaptive) return value;
  if (
    typeof value.network !== 'string' ||
    !['ae_uat', 'ae_mainnet'].includes(value.network) ||
    typeof value.contract !== 'string' ||
    !/^ct_[a-zA-Z0-9]{1,97}$/.test(value.contract)
  )
    throw new Error('Invalid playback scope');
  if (
    original?.version !== 1 ||
    !sha(original.sha256) ||
    !['video/mp4', 'video/quicktime'].includes(original.mediaType) ||
    original.importProfile !== 'unixfs-file-v1-262144' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes! < 1 ||
    value.bytes! > 100000000 ||
    delivery?.version !== 1 ||
    !cidPattern.test(delivery.cid) ||
    !cidPattern.test(delivery.assetsCid) ||
    new Set([value.cid, delivery.cid, delivery.assetsCid]).size !== 3 ||
    delivery.profile !== 'original-h264-v1' ||
    !sha(delivery.fingerprint) ||
    !delivery.generation ||
    typeof delivery.generation.job !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(delivery.generation.job) ||
    typeof delivery.generation.fence !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(delivery.generation.fence) ||
    BigInt(delivery.generation.fence) > 9223372036854775807n ||
    !Array.isArray(delivery.videos) ||
    delivery.videos.length < 2 ||
    delivery.videos.length > 5 ||
    value.files.reduce((sum, file) => sum + file.bytes, 0) > derivativeLimit ||
    value.files
      .filter((file) => assetNames.includes(file.name))
      .reduce((sum, file) => sum + file.bytes, 0) >
      64 * 1048576
  )
    throw new Error('Invalid original playback descriptor');
  const names = new Set(value.files.map((file) => file.name)),
    videos = new Set<string>();
  if (
    !['video.mp4', 'poster.jpg', 'manifest.json'].every((name) =>
      names.has(name),
    ) ||
    names.has('audio-main.m4a') !== names.has('audio-rescue.m4a')
  )
    throw new Error('Incomplete playback inputs');
  for (const video of delivery.videos) {
    const rate = /^(\d{1,7})\/(\d{1,7})$/.exec(video?.frameRate || ''),
      fps = Number(rate?.[1]) / Number(rate?.[2]);
    if (
      !/^video-(1080|720|480|360|rescue)\.mp4$/.test(video?.name || '') ||
      !names.has(video.name) ||
      videos.has(video.name) ||
      !Number.isInteger(video.width) ||
      !Number.isInteger(video.height) ||
      video.width < 2 ||
      video.height < 2 ||
      video.width > 1920 ||
      video.height > 1920 ||
      video.width % 2 ||
      video.height % 2 ||
      video.width * video.height > 2073600 ||
      !Number.isFinite(fps) ||
      fps < 1 ||
      fps > 60
    )
      throw new Error('Invalid prepared video track');
    videos.add(video.name);
  }
  if (
    !videos.has('video-rescue.mp4') ||
    [...names].some((name) => name.startsWith('video-') && !videos.has(name))
  )
    throw new Error('Incomplete prepared video ladder');
  return value;
}

/** Explicit canonical serialization is shared with the API inventory protocol. */
export function adaptiveSourceIdentity(value: PlaybackDescriptor) {
  validateDescriptor(value);
  if (!value.original || !value.derivatives)
    throw new Error('Original playback identity missing');
  const order = <T extends { name: string }>(values: T[]) =>
    values.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify({
    id: value.id,
    network: value.network ?? null,
    contract: value.contract ?? null,
    cid: value.cid,
    bytes: value.bytes,
    sha256: value.original.sha256,
    cidVersion: value.original.importProfile,
    delivery: value.derivatives.cid,
    assets: value.derivatives.assetsCid,
    profile: value.derivatives.profile,
    fingerprint: value.derivatives.fingerprint,
    generation: {
      job: value.derivatives.generation.job,
      fence: value.derivatives.generation.fence,
    },
    videos: order(
      value.derivatives.videos.map(({ name, width, height, frameRate }) => ({
        name,
        width,
        height,
        frameRate,
      })),
    ),
    files: order(
      value.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    ),
  });
}

/** Durable acknowledgement identity; the legacy source key remains unchanged. */
export function deliverySourceIdentity(value: PlaybackDescriptor) {
  validateDescriptor(value);
  if (value.original || value.derivatives) return adaptiveSourceIdentity(value);
  if (
    !['ae_uat', 'ae_mainnet'].includes(value.network || '') ||
    !/^ct_[a-zA-Z0-9]{1,97}$/.test(value.contract || '') ||
    !value.files.some((file) => file.name === 'video.mp4')
  )
    throw new Error('Invalid legacy delivery scope');
  return JSON.stringify({
    version: 2,
    id: value.id,
    network: value.network,
    contract: value.contract,
    cid: value.cid,
    generation: { job: value.id },
    files: value.files
      .map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  });
}
