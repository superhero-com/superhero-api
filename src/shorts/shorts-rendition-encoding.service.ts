import { Injectable } from '@nestjs/common';
import { runShortsMediaCommand as run } from './shorts-media-command';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ShortsScratchService,
  ScratchCapacityError,
} from './shorts-scratch.service';
import { ShortsMediaFile, hashMediaFile } from './shorts-media-file';
import type { IngestionInput } from './shorts-metadata.service';
import { ShortsPackageService } from './shorts-package.service';
import {
  shortsPosterFrame,
  SHORTS_POSTER_MAX_FRAMES,
  SHORTS_POSTER_SAMPLE_BYTES,
  SHORTS_POSTER_POLICY,
} from './shorts-poster';
import {
  derivedFiles,
  SHORTS_ASSET_MAX_BYTES,
} from './shorts-original-content';
import {
  encodingRecipe,
  recordEncodingCommand,
  encodingFingerprint,
} from './shorts-encoding-recipe';
import {
  SHORTS_RENDITION_MAX_BYTES,
  ShortsRendition,
  ShortsVideoProbe,
  shortsRenditions,
  shortsVideoProbe,
  shortsHdrColorFilter,
  shortsHdrRenditionFilter,
  SHORTS_HDR_LINEAR_FILTER,
} from './shorts-rendition-policy';

export interface ShortsPreparedRenditions {
  source: ShortsMediaFile;
  originalCid: string;
  probe: ShortsVideoProbe;
  fingerprint: string;
  videos: ShortsRendition[];
  files: (ShortsMediaFile & { name: string })[];
}

/** Encodes original-derived tracks; the caller persists them before scratch cleanup. */
@Injectable()
export class ShortsRenditionEncodingService {
  constructor(
    private readonly scratch: ShortsScratchService,
    private readonly packages: ShortsPackageService,
  ) {}

  async prepare<T>(
    source: ShortsMediaFile,
    persist: (
      prepared: ShortsPreparedRenditions,
      signal: AbortSignal,
    ) => Promise<T>,
    parent?: AbortSignal,
    metadata: Pick<IngestionInput, 'title' | 'topic' | 'details'> = {
      title: '',
      topic: '',
      details: {},
    },
  ): Promise<T> {
    const reservation = await this.scratch.reserve(
      SHORTS_RENDITION_MAX_BYTES + 128 * 1048576,
      20,
      parent,
    );
    const signal = AbortSignal.any([
      reservation.signal,
      ...(parent ? [parent] : []),
    ]);
    let directory: string | undefined;
    try {
      const identity = await hashMediaFile(source.path, signal);
      if (identity.bytes !== source.bytes || identity.sha256 !== source.sha256)
        throw new Error('Original file integrity mismatch');
      const originalCid = await this.packages.originalCid(source, signal);
      directory = await mkdtemp(
        join(this.scratch.directory, 'shorts-renditions-'),
      );
      const options = {
        signal,
        maxBuffer: 1048576,
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          LANG: 'C',
          HOME: directory,
          TMPDIR: directory,
        },
      };
      const versionResults = await Promise.allSettled(
        (['ffmpeg', 'ffprobe'] as const).map((program) =>
          run(program, ['-version'], {
            ...options,
            timeout: 5000,
            maxBuffer: 65536,
          }),
        ),
      );
      const versions = versionResults.map((result) => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
      const recipe = encodingRecipe({
        ffmpeg: versions[0].stdout,
        ffprobe: versions[1].stdout,
      });
      const mediaRun = (
        program: 'ffmpeg' | 'ffprobe',
        args: string[],
        timeout: number,
      ) => {
        recordEncodingCommand(recipe, program, args, source.path, directory);
        return run(program, args, { ...options, timeout });
      };
      const { stdout } = await mediaRun(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          '-protocol_whitelist',
          'file,pipe',
          source.path,
        ],
        15000,
      );
      const probe = shortsVideoProbe(JSON.parse(stdout));
      const videos = shortsRenditions(probe);
      const files: ShortsPreparedRenditions['files'] = [];
      let bytes = 0;
      const input = [
        '-nostdin',
        '-y',
        '-v',
        'error',
        '-xerror',
        '-filter_threads',
        '2',
        '-protocol_whitelist',
        'file,pipe',
        '-threads',
        '2',
        // Keep container offsets even when every stream starts after zero.
        '-copyts',
        '-i',
        source.path,
      ];
      const filters = (width: number, height: number) =>
        probe.hdr
          ? `${shortsHdrColorFilter({ width, height })},setsar=1`
          : `scale=${width}:${height},setsar=1,${probe.colorFilter}`;
      const save = async (name: string) => {
        const file = await hashMediaFile(join(directory, name), signal);
        bytes += file.bytes;
        if (bytes > SHORTS_RENDITION_MAX_BYTES)
          throw new Error('Delivery tracks exceed the media budget');
        files.push({ ...file, name });
      };
      // Inspect every decoded source frame at a tiny raster. The extra frame
      // detects an exceeded decode budget; neither timestamps nor reported
      // frame counts can turn this into an unbounded capture.
      const posterFrame = await (async () => {
        const args = [
          ...input,
          '-map',
          '0:v:0',
          '-an',
          '-sn',
          '-dn',
          '-vf',
          `${filters(SHORTS_POSTER_POLICY.side, SHORTS_POSTER_POLICY.side)},format=gray`,
          '-fps_mode',
          'passthrough',
          '-frames:v',
          String(SHORTS_POSTER_MAX_FRAMES + 1),
          '-pix_fmt',
          'gray',
          '-f',
          'rawvideo',
          'pipe:1',
        ];
        recordEncodingCommand(recipe, 'ffmpeg', args, source.path, directory);
        const { stdout: samples } = await run('ffmpeg', args, {
          ...options,
          timeout: 120000,
          encoding: 'buffer',
          maxBuffer:
            (SHORTS_POSTER_MAX_FRAMES + 1) * SHORTS_POSTER_SAMPLE_BYTES,
        });
        return shortsPosterFrame(samples);
      })();
      // All tracks retain the container timeline, including held boundary frames.
      const cadence = (video: ShortsRendition) =>
        `fps=${video.frameRate}:start_time=0`;
      const boundaries = `tpad=stop_mode=clone:stop_duration=${probe.duration},trim=duration=${probe.duration}`;
      const timeline = (video: ShortsRendition) =>
        `${cadence(video)},${boundaries}`;
      const encodingOptions = (video: ShortsRendition) => {
        const [numerator, denominator] = video.frameRate.split('/').map(Number);
        const gop = Math.ceil((2 * numerator) / denominator);
        return [
          '-fps_mode',
          'cfr',
          '-c:v',
          'libx264',
          '-preset',
          'medium',
          '-crf',
          String(video.crf),
          '-maxrate',
          video.maxrate,
          '-bufsize',
          video.bufsize,
          '-pix_fmt',
          'yuv420p',
          '-profile:v',
          'high',
          '-level:v',
          video.level,
          '-g',
          String(gop),
          '-keyint_min',
          String(gop),
          '-sc_threshold',
          '0',
          '-force_key_frames',
          'expr:gte(t,n_forced*2)',
          '-color_primaries',
          'bt709',
          '-color_trc',
          'bt709',
          '-colorspace',
          'bt709',
          '-color_range',
          'tv',
          '-x264-params',
          'colorprim=bt709:transfer=bt709:colormatrix=bt709',
          '-map_metadata',
          '-1',
          '-movflags',
          '+faststart',
          '-threads',
          '2',
          join(directory, video.name),
        ];
      };
      // Keep the top encoder separate to bound memory. Smaller HDR renditions
      // share one source decode and linearization while retaining their own
      // resize, tone map, cadence and codec settings.
      const groups = probe.hdr
        ? [videos.slice(0, 1), videos.slice(1)]
        : videos.map((video) => [video]);
      for (const group of groups) {
        if (!group.length) continue;
        let args: string[];
        if (group.length === 1) {
          const video = group[0];
          args = [
            ...input,
            '-map',
            '0:v:0',
            '-an',
            '-sn',
            '-dn',
            '-vf',
            `${filters(video.width, video.height)},${timeline(video)}`,
            ...encodingOptions(video),
          ];
        } else {
          const graph =
            `[0:v:0]${SHORTS_HDR_LINEAR_FILTER},split=${group.length}` +
            group.map((_, index) => `[linear${index}]`).join('') +
            ';' +
            group
              .map(
                (video, index) =>
                  // Skip frames before per-rendition tone mapping, retaining
                  // the same selection and held container-boundary frames.
                  `[linear${index}]${cadence(video)},${shortsHdrRenditionFilter(video)},setsar=1,${boundaries}[video${index}]`,
              )
              .join(';');
          args = [
            ...input,
            '-filter_complex_threads',
            '2',
            '-filter_complex',
            graph,
            ...group.flatMap((video, index) => [
              '-map',
              `[video${index}]`,
              '-an',
              '-sn',
              '-dn',
              ...encodingOptions(video),
            ]),
          ];
        }
        await mediaRun('ffmpeg', args, 300000);
        for (const video of group) await save(video.name);
      }
      if (probe.audioChannels) {
        for (const [name, bitrate, channels] of [
          ['audio-main.m4a', '192k', probe.audioChannels],
          ['audio-rescue.m4a', '48k', probe.audioChannels],
        ] as const) {
          await mediaRun(
            'ffmpeg',
            [
              ...input,
              '-map',
              '0:a:0',
              '-vn',
              '-sn',
              '-dn',
              // Materialize timestamp gaps as silence before splitting audio
              // from video; remuxing must not move the first audible sample.
              '-af',
              `aresample=48000:async=1:min_hard_comp=0.001:first_pts=0,apad=whole_dur=${probe.duration},atrim=duration=${probe.duration}`,
              '-c:a',
              'aac',
              '-profile:a',
              'aac_low',
              '-b:a',
              bitrate,
              '-ar',
              '48000',
              '-ac',
              String(channels),
              '-map_metadata',
              '-1',
              '-movflags',
              '+faststart',
              join(directory, name),
            ],
            120000,
          );
          await save(name);
        }
      }
      await mediaRun(
        'ffmpeg',
        [
          ...input,
          '-map',
          '0:v:0',
          '-an',
          '-vf',
          `select='eq(n,${posterFrame})',${filters(videos[0].width, videos[0].height)}`,
          '-fps_mode',
          'passthrough',
          '-frames:v',
          '1',
          '-q:v',
          String(SHORTS_POSTER_POLICY.jpegQuality),
          '-threads',
          '1',
          join(directory, 'poster.jpg'),
        ],
        30000,
      );
      await save('poster.jpg');
      // Studio preview reuses an encoded track; it never becomes the original CID.
      const normal = videos.filter(
        (video) => video.name !== 'video-rescue.mp4',
      );
      const preview =
        normal.find((video) => video.width * video.height <= 480 * 854) ||
        normal.at(-1);
      await mediaRun(
        'ffmpeg',
        [
          '-nostdin',
          '-y',
          '-v',
          'error',
          '-xerror',
          '-protocol_whitelist',
          'file,pipe',
          '-i',
          join(directory, preview.name),
          ...(probe.audioChannels
            ? ['-i', join(directory, 'audio-main.m4a')]
            : []),
          '-map',
          '0:v:0',
          ...(probe.audioChannels ? ['-map', '1:a:0'] : []),
          '-c',
          'copy',
          '-map_metadata',
          '-1',
          '-movflags',
          '+faststart',
          join(directory, 'video.mp4'),
        ],
        30000,
      );
      await save('video.mp4');
      const captions = metadata.details.captions;
      if (captions) {
        if (
          typeof captions !== 'string' ||
          captions.length > 10000 ||
          !captions.startsWith('WEBVTT') ||
          !captions.includes('-->') ||
          /<[^>]+>|STYLE|REGION|X-TIMESTAMP-MAP/.test(captions)
        )
          throw new Error('Invalid captions');
        await writeFile(join(directory, 'captions.vtt'), captions, {
          flag: 'wx',
          mode: 0o600,
          signal,
        });
        await save('captions.vtt');
      }
      const fingerprint = encodingFingerprint(recipe);
      await writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify({
          version: 2,
          title: metadata.title,
          topic: metadata.topic,
          details: metadata.details,
          original: {
            cid: originalCid,
            bytes: source.bytes,
            sha256: source.sha256,
            mediaType: probe.mediaType,
          },
          duration: probe.duration,
          fingerprint,
          recipe,
          videos: videos.map(({ name, width, height, frameRate }) => ({
            name,
            width,
            height,
            frameRate,
          })),
          files: files.map(({ name, bytes, sha256 }) => ({
            name,
            bytes,
            sha256,
          })),
        }),
        { flag: 'wx', mode: 0o600, signal },
      );
      await save('manifest.json');
      if (
        derivedFiles(files, 'assets').reduce(
          (sum, file) => sum + file.bytes,
          0,
        ) > SHORTS_ASSET_MAX_BYTES
      )
        throw new Error('Preview assets exceed the media budget');
      signal.throwIfAborted();
      return await persist(
        {
          source,
          originalCid,
          probe,
          fingerprint,
          videos,
          files,
        },
        signal,
      );
    } catch (error) {
      if (reservation.signal.reason instanceof ScratchCapacityError)
        throw reservation.signal.reason;
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['ENOSPC', 'EDQUOT'].includes(String(error.code))
      )
        throw new ScratchCapacityError();
      if (!signal.aborted) await this.scratch.assertHeadroom();
      throw error;
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        reservation.release();
      }
    }
  }
}
