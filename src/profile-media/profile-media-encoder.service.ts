import { BadRequestException, Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { MediaRole, IMAGE_MAX_BYTES } from './profile-media.config';

@Injectable()
export class ProfileMediaEncoder {
  async encode(
    input: Buffer,
    role: MediaRole,
  ): Promise<{ width: number; height: number; image: Buffer; thumb: Buffer }> {
    if (!input?.length || input.length > IMAGE_MAX_BYTES)
      throw new BadRequestException('Choose an image up to 10 MiB');
    return new Promise((resolve, reject) => {
      // Environment is deliberately minimal: native decoding has no service keys.
      const child = spawn(
        process.execPath,
        ['--max-old-space-size=128', join(__dirname, 'image-worker.cjs'), role],
        {
          env: {
            PATH: process.env.PATH || '/usr/bin:/bin',
            VIPS_CONCURRENCY: '1',
            MALLOC_ARENA_MAX: '2',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const chunks: Buffer[] = [];
      let bytes = 0,
        stderrBytes = 0;
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      const invalid = () =>
        new BadRequestException(
          'Use a valid, still JPEG, PNG or WebP image, at least 128 pixels per side and up to 24 megapixels',
        );
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 5 * 1024 * 1024) child.kill('SIGKILL');
        else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 65536) child.kill('SIGKILL');
      });
      child.on('error', () => {
        clearTimeout(timer);
        reject(invalid());
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(invalid());
          return;
        }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const image = Buffer.from(result.image, 'base64'),
            thumb = Buffer.from(result.thumb, 'base64');
          if (
            !image.length ||
            !thumb.length ||
            !Number.isInteger(result.width) ||
            !Number.isInteger(result.height)
          )
            throw new Error();
          resolve({ width: result.width, height: result.height, image, thumb });
        } catch {
          reject(invalid());
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
}
