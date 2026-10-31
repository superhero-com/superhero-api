import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ShortsScratchService,
  ScratchCapacityError,
} from './shorts-scratch.service';
const run = promisify(execFile);

/** Shared worker/local-demo decoder. Hosted API routes never decode media. */
@Injectable()
export class ShortsEncodingService {
  constructor(private readonly scratch: ShortsScratchService) {}
  async encode(
    input: Buffer,
    title: string,
    topic: string,
    details: {
      description?: string;
      language?: string;
      synthetic?: boolean;
      sponsored?: boolean;
      captions?: string;
    } = {},
    signal?: AbortSignal,
  ) {
    if (
      !Buffer.isBuffer(input) ||
      input.length < 1 ||
      input.length > 40 * 1024 * 1024
    )
      throw new Error('Choose a video up to 40 MiB');
    const reservation = await this.scratch.reserve(192 * 1048576, 16, signal);
    signal = AbortSignal.any([reservation.signal, ...(signal ? [signal] : [])]);
    let temp: string;
    try {
      signal.throwIfAborted();
      temp = await mkdtemp(join(this.scratch.directory, 'shorts-transcode-'));
      const options = {
        signal,
        killSignal: 'SIGKILL' as const,
        maxBuffer: 1024 * 1024,
        cwd: temp,
        env: { PATH: process.env.PATH, LANG: 'C', HOME: temp, TMPDIR: temp },
      };
      await writeFile(join(temp, 'input'), input, { mode: 0o600, signal });
      const { stdout } = await run(
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
          join(temp, 'input'),
        ],
        { ...options, timeout: 15000 },
      );
      const probe = JSON.parse(stdout);
      const stream = probe.streams.find((s: any) => s.codec_type === 'video');
      const duration = Number(probe.format.duration);
      if (
        !stream ||
        !Number.isSafeInteger(stream.width) ||
        !Number.isSafeInteger(stream.height) ||
        stream.width < 1 ||
        stream.height < 1 ||
        !Number.isFinite(duration) ||
        duration < 2 ||
        !String(probe.format.format_name)
          .split(',')
          .some((format) => ['mov', 'mp4'].includes(format)) ||
        duration > 60 ||
        stream.width * stream.height > 3840 * 2160
      )
        throw new Error(
          'Choose an MP4/MOV video between 2 and 60 seconds, up to 4K',
        );
      await run(
        'ffmpeg',
        [
          '-nostdin',
          '-y',
          '-v',
          'error',
          // Stop on damaged packets instead of silently publishing a partial clip.
          '-xerror',
          '-filter_threads',
          '2',
          '-protocol_whitelist',
          'file,pipe',
          // Input options bound decoding separately from the output encoder.
          '-threads',
          '2',
          '-i',
          join(temp, 'input'),
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-t',
          '60',
          '-vf',
          'scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2,setsar=1',
          '-r',
          '30',
          '-maxrate',
          '2500k',
          '-bufsize',
          '5000k',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '26',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '96k',
          '-movflags',
          '+faststart',
          '-threads',
          '2',
          '-fs',
          '67108864',
          join(temp, 'video.mp4'),
        ],
        { ...options, timeout: 120000 },
      );
      await run(
        'ffmpeg',
        [
          '-nostdin',
          '-y',
          '-v',
          'error',
          '-xerror',
          '-filter_threads',
          '1',
          '-protocol_whitelist',
          'file,pipe',
          '-threads',
          '1',
          '-i',
          join(temp, 'video.mp4'),
          '-frames:v',
          '1',
          '-threads',
          '1',
          '-fs',
          '67108864',
          join(temp, 'poster.jpg'),
        ],
        { ...options, timeout: 15000 },
      );
      for (const name of ['video.mp4', 'poster.jpg']) {
        if ((await stat(join(temp, name))).size >= 64 * 1024 * 1024)
          throw new Error('Prepared media exceeds the object limit');
      }
      const files = [
        { name: 'video.mp4', data: await readFile(join(temp, 'video.mp4')) },
        { name: 'poster.jpg', data: await readFile(join(temp, 'poster.jpg')) },
        {
          name: 'manifest.json',
          data: Buffer.from(
            JSON.stringify({
              version: 1,
              title,
              topic,
              duration,
              video: 'video.mp4',
              poster: 'poster.jpg',
              classification: 'creator-declared',
              description: details.description || '',
              language: details.language || 'und',
              synthetic: details.synthetic === true,
              sponsored: details.sponsored === true,
              captions: details.captions ? 'captions.vtt' : undefined,
            }),
          ),
        },
      ];
      if (details.captions)
        files.push({
          name: 'captions.vtt',
          data: Buffer.from(details.captions),
        });
      const bytes = files.reduce((n, f) => n + f.data.length, 0);
      if (bytes > 64 * 1024 * 1024)
        throw new Error('Processed package exceeds 64 MiB');
      signal.throwIfAborted();
      return { bytes, duration, files };
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
      // A full disk can make the child exit before the next monitor tick.
      // Recheck actual headroom, never classify untrusted decoder stderr.
      if (!signal.aborted) await this.scratch.assertHeadroom();
      throw error;
    } finally {
      try {
        if (temp) await rm(temp, { recursive: true, force: true });
      } finally {
        reservation.release();
      }
    }
  }
}
