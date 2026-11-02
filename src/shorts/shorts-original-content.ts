import type { ShortRecord } from './shorts.types';
import { SHORTS_ORIGINAL_HARD_LIMIT } from './shorts-media-file';
import {
  SHORTS_ORIGINAL_PROFILE,
  SHORTS_RENDITION_MAX_BYTES,
} from './shorts-rendition-policy';

export interface ShortsOriginalIdentity {
  version: 1;
  sha256: string;
  mediaType: 'video/mp4' | 'video/quicktime';
  importProfile: 'unixfs-file-v1-262144';
}
export interface ShortsDerivedMedia {
  version: 1;
  /** Temporary encoded video/audio inputs. */
  cid: string;
  /** Independently retained preview, poster, captions and manifest. */
  assetsCid: string;
  profile: typeof SHORTS_ORIGINAL_PROFILE;
  fingerprint: string;
  generation: { job: string; fence: string };
  videos: { name: string; width: number; height: number; frameRate: string }[];
}
export const SHORTS_INPUT_NAMES = [
  'video-1080.mp4',
  'video-720.mp4',
  'video-480.mp4',
  'video-360.mp4',
  'video-rescue.mp4',
  'audio-main.m4a',
  'audio-rescue.m4a',
] as const;
export const SHORTS_ASSET_NAMES = [
  'video.mp4',
  'poster.jpg',
  'manifest.json',
  'captions.vtt',
] as const;
export const SHORTS_DERIVED_NAMES = [
  ...SHORTS_INPUT_NAMES,
  ...SHORTS_ASSET_NAMES,
] as const;
export const SHORTS_ASSET_MAX_BYTES = 64 * 1048576;
export type ShortsDerivedPackage = 'inputs' | 'assets';
export function derivedFiles<T extends { name: string }>(
  files: T[],
  kind: ShortsDerivedPackage,
): T[] {
  const names: readonly string[] =
    kind === 'inputs' ? SHORTS_INPUT_NAMES : SHORTS_ASSET_NAMES;
  return files.filter((file) => names.includes(file.name));
}
export function derivedFileCid(
  short: Pick<ShortRecord, 'cid' | 'derivatives'>,
  name: string,
) {
  if (!short.derivatives) return short.cid;
  if ((SHORTS_ASSET_NAMES as readonly string[]).includes(name))
    return short.derivatives.assetsCid;
  if ((SHORTS_INPUT_NAMES as readonly string[]).includes(name))
    return short.derivatives.cid;
  throw new Error('Unknown derived media file');
}
const cidPattern = /^b[a-z2-7]{20,118}$/;
const shaPattern = /^[a-f0-9]{64}$/;

/** New records bind original identity and separate prepared delivery; legacy records remain distinct. */
export function validateOriginalContent(short: ShortRecord) {
  if (short.original === undefined && short.derivatives === undefined)
    return false;
  const original = short.original,
    delivery = short.derivatives;
  if (
    original?.version !== 1 ||
    !shaPattern.test(original.sha256) ||
    !['video/mp4', 'video/quicktime'].includes(original.mediaType) ||
    original.importProfile !== 'unixfs-file-v1-262144' ||
    !cidPattern.test(short.cid) ||
    !Number.isSafeInteger(short.bytes) ||
    short.bytes < 1 ||
    short.bytes > SHORTS_ORIGINAL_HARD_LIMIT ||
    delivery?.version !== 1 ||
    delivery.profile !== SHORTS_ORIGINAL_PROFILE ||
    !cidPattern.test(delivery.cid) ||
    !cidPattern.test(delivery.assetsCid) ||
    new Set([short.cid, delivery.cid, delivery.assetsCid]).size !== 3 ||
    !shaPattern.test(delivery.fingerprint) ||
    typeof delivery.generation?.job !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(delivery.generation.job) ||
    delivery.generation?.job !== short.id ||
    typeof delivery.generation?.fence !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(delivery.generation.fence) ||
    BigInt(delivery.generation.fence) > 9223372036854775807n ||
    !Array.isArray(short.files) ||
    short.files.length < 5 ||
    short.files.length > SHORTS_DERIVED_NAMES.length ||
    !Array.isArray(delivery.videos) ||
    delivery.videos.length < 2 ||
    delivery.videos.length > 5 ||
    short.privateMedia === null
  )
    throw new Error('Invalid original video identity');
  const files = new Map<string, ShortRecord['files'][number]>();
  let bytes = 0;
  for (const file of short.files) {
    if (
      !file ||
      !(SHORTS_DERIVED_NAMES as readonly string[]).includes(file.name) ||
      files.has(file.name) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > SHORTS_ORIGINAL_HARD_LIMIT ||
      !shaPattern.test(file.sha256)
    )
      throw new Error('Invalid original video derivative');
    files.set(file.name, file);
    bytes += file.bytes;
  }
  if (
    bytes > SHORTS_RENDITION_MAX_BYTES ||
    derivedFiles(short.files, 'assets').reduce(
      (sum, file) => sum + file.bytes,
      0,
    ) > SHORTS_ASSET_MAX_BYTES ||
    !files.has('video.mp4') ||
    !files.has('poster.jpg') ||
    !files.has('manifest.json') ||
    files.has('audio-main.m4a') !== files.has('audio-rescue.m4a') ||
    files.has('captions.vtt') !== !!short.captions
  )
    throw new Error('Incomplete original video derivatives');
  const videos = new Set<string>();
  for (const video of delivery.videos) {
    const rate = /^(\d{1,7})\/(\d{1,7})$/.exec(video?.frameRate || '');
    const fps = Number(rate?.[1]) / Number(rate?.[2]);
    if (
      !/^video-(1080|720|480|360|rescue)\.mp4$/.test(video?.name || '') ||
      !files.has(video.name) ||
      videos.has(video.name) ||
      !Number.isInteger(video.width) ||
      !Number.isInteger(video.height) ||
      video.width < 2 ||
      video.height < 2 ||
      video.width > 1920 ||
      video.height > 1920 ||
      video.width % 2 ||
      video.height % 2 ||
      video.width * video.height > 1920 * 1080 ||
      !Number.isFinite(fps) ||
      fps < 1 ||
      fps > 60
    )
      throw new Error('Invalid original video rendition');
    videos.add(video.name);
  }
  if (
    !videos.has('video-rescue.mp4') ||
    [...files.keys()].some((name) => /^video-/.test(name) && !videos.has(name))
  )
    throw new Error('Incomplete original video ladder');
  if (
    short.privateMedia &&
    (short.privateMedia.fence !== delivery.generation.fence ||
      short.privateMedia.source.processingProfile !== SHORTS_ORIGINAL_PROFILE ||
      short.privateMedia.source.bytes !== short.bytes ||
      short.privateMedia.source.sha256 !== original.sha256)
  )
    throw new Error('Original video differs from accepted source');
  return true;
}
