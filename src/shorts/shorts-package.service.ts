import { Injectable } from '@nestjs/common';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';

/** Matches the explicit Kubo add parameters without sending private bytes to IPFS. */
@Injectable()
export class ShortsPackageService {
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
        chunker: fixedSize({ chunkSize: 262144 }),
        layout: balanced({ maxChildrenPerNode: 174 }),
      },
    )) {
      signal?.throwIfAborted();
      if (!entry.path) result = entry.cid.toString();
    }
    if (!result) throw new Error('Could not calculate package identity');
    return result;
  }
}
