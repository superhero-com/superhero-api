import {
  SHORTS_IPFS_CHUNK_BYTES,
  SHORTS_IPFS_FILE_MAX_LINKS,
} from './shorts-ipfs-import-profile';
import { Injectable } from '@nestjs/common';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';
import { createReadStream } from 'node:fs';
import {
  SHORTS_INPUT_NAMES,
  SHORTS_ASSET_NAMES,
  SHORTS_ASSET_MAX_BYTES,
  ShortsDerivedPackage,
} from './shorts-original-content';
import { SHORTS_RENDITION_MAX_BYTES } from './shorts-rendition-policy';
import {
  ShortsMediaFile,
  validateMediaIdentity,
  verifiedMediaBytes,
} from './shorts-media-file';

/** Matches the explicit Kubo add parameters without sending private bytes to IPFS. */
@Injectable()
export class ShortsPackageService {
  /** Disjoint input/asset directories, never the published original identity. */
  async derivativeCid(
    files: (ShortsMediaFile & { name: string })[],
    kind: ShortsDerivedPackage,
    signal?: AbortSignal,
  ) {
    const allowed: readonly string[] =
      kind === 'inputs' ? SHORTS_INPUT_NAMES : SHORTS_ASSET_NAMES;
    const names = new Set(files.map((file) => file.name));
    if (
      !['inputs', 'assets'].includes(kind) ||
      files.length < (kind === 'inputs' ? 2 : 3) ||
      files.length > allowed.length ||
      names.size !== files.length ||
      files.some((file) => !allowed.includes(file.name)) ||
      (kind === 'inputs'
        ? !names.has('video-rescue.mp4') ||
          !files.some((file) =>
            /^video-(1080|720|480|360)\.mp4$/.test(file.name),
          ) ||
          names.has('audio-main.m4a') !== names.has('audio-rescue.m4a')
        : !['video.mp4', 'poster.jpg', 'manifest.json'].every((name) =>
            names.has(name),
          ))
    )
      throw new Error('Invalid derivative package');
    for (const file of files) validateMediaIdentity(file);
    if (
      files.reduce((sum, file) => sum + file.bytes, 0) >
      (kind === 'inputs' ? SHORTS_RENDITION_MAX_BYTES : SHORTS_ASSET_MAX_BYTES)
    )
      throw new Error('Derivative package exceeds media budget');
    async function* entries() {
      for (const file of files) {
        signal?.throwIfAborted();
        yield {
          path: file.name,
          content: verifiedMediaBytes(
            createReadStream(file.path, { signal }),
            file,
            signal,
          ),
        };
      }
    }
    let result: string | undefined;
    for await (const entry of importer(
      entries(),
      {
        put: async (cid) => {
          signal?.throwIfAborted();
          return cid;
        },
      },
      {
        cidVersion: 1,
        rawLeaves: true,
        wrapWithDirectory: true,
        reduceSingleLeafToSelf: true,
        chunker: fixedSize({ chunkSize: SHORTS_IPFS_CHUNK_BYTES }),
        layout: balanced({ maxChildrenPerNode: SHORTS_IPFS_FILE_MAX_LINKS }),
      },
    )) {
      signal?.throwIfAborted();
      if (!entry.path) result = entry.cid.toString();
    }
    if (!result) throw new Error('Could not calculate derivative identity');
    return result;
  }

  /** The original file's CID, with no containing directory or transformed bytes. */
  async originalCid(source: ShortsMediaFile, signal?: AbortSignal) {
    validateMediaIdentity(source);
    signal?.throwIfAborted();
    return this.originalStreamCid(
      createReadStream(source.path, { signal }),
      source,
      signal,
    );
  }

  async originalStreamCid(
    source: AsyncIterable<Uint8Array>,
    identity: Pick<ShortsMediaFile, 'bytes' | 'sha256'>,
    signal?: AbortSignal,
  ) {
    let result: string | undefined;
    for await (const entry of importer(
      [{ content: verifiedMediaBytes(source, identity, signal) }],
      {
        put: async (cid) => {
          signal?.throwIfAborted();
          return cid;
        },
      },
      {
        cidVersion: 1,
        rawLeaves: true,
        wrapWithDirectory: false,
        reduceSingleLeafToSelf: true,
        chunker: fixedSize({ chunkSize: SHORTS_IPFS_CHUNK_BYTES }),
        layout: balanced({ maxChildrenPerNode: SHORTS_IPFS_FILE_MAX_LINKS }),
      },
    )) {
      signal?.throwIfAborted();
      result = entry.cid.toString();
    }
    if (!result) throw new Error('Could not calculate original file identity');
    return result;
  }

  async cid(files: { name: string; data: Buffer }[], signal?: AbortSignal) {
    if (
      files.length < 1 ||
      files.length > 4 ||
      new Set(files.map((f) => f.name)).size !== files.length ||
      files.some(
        (file) =>
          ![
            'video.mp4',
            'poster.jpg',
            'manifest.json',
            'captions.vtt',
          ].includes(file.name),
      )
    )
      throw new Error('Invalid Shorts media package');
    let result: string;
    for await (const entry of importer(
      files.map((file) => ({ path: file.name, content: file.data })),
      {
        put: async (cid) => {
          signal?.throwIfAborted();
          return cid;
        },
      },
      {
        cidVersion: 1,
        rawLeaves: true,
        wrapWithDirectory: true,
        reduceSingleLeafToSelf: true,
        chunker: fixedSize({ chunkSize: SHORTS_IPFS_CHUNK_BYTES }),
        layout: balanced({ maxChildrenPerNode: SHORTS_IPFS_FILE_MAX_LINKS }),
      },
    )) {
      signal?.throwIfAborted();
      if (!entry.path) result = entry.cid.toString();
    }
    if (!result) throw new Error('Could not calculate package identity');
    return result;
  }
}
