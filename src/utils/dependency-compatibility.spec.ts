import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  createReadStream,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import request from 'supertest';
import multer from 'multer';
import { v4, v5, validate } from 'uuid';
import * as argon2 from 'argon2';
import qs from 'qs';
import uri from 'fast-uri';

describe('Security dependency override compatibility', () => {
  it('preserves UUID consumers and deterministic namespace identifiers', () => {
    expect(validate(v4())).toBe(true);
    expect(v5('www.example.com', v5.DNS)).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
    for (const consumer of ['bull', '@metamask/utils', 'typeorm']) {
      const uuid = createRequire(require.resolve(consumer))('uuid');
      expect(validate(uuid.v4())).toBe(true);
    }
  });
  it('preserves native Argon2 hash/verify and node-pre-gyp streaming extraction', async () => {
    const hash = await argon2.hash('disposable-test-input', {
      memoryCost: 1024,
      timeCost: 2,
      parallelism: 1,
    });
    expect(await argon2.verify(hash, 'disposable-test-input')).toBe(true);
    expect(await argon2.verify(hash, 'different-input')).toBe(false);
    const tar = createRequire(require.resolve('@mapbox/node-pre-gyp'))('tar');
    const directory = mkdtempSync(join(tmpdir(), 'social-dependency-compat-'));
    try {
      const source = join(directory, 'source'),
        output = join(directory, 'out');
      mkdirSync(join(source, 'package'), { recursive: true });
      mkdirSync(output);
      writeFileSync(
        join(source, 'package', 'fixture.txt'),
        'native-package-fixture',
      );
      const archive = join(directory, 'fixture.tgz');
      await tar.create({ cwd: source, gzip: true, file: archive }, ['package']);
      await pipeline(
        createReadStream(archive),
        tar.extract({ cwd: output, strip: 1 }),
      );
      expect(readFileSync(join(output, 'fixture.txt'), 'utf8')).toBe(
        'native-package-fixture',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('retains multipart upload and file-size rejection behavior', async () => {
    const app = express();
    app.post(
      '/upload',
      multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 16 },
      }).single('file'),
      (req: any, res) =>
        res.json({ name: req.body.name, file: req.file.buffer.toString() }),
    );
    app.use((error: any, _req: any, res: any, _next: any) => {
      void _req;
      void _next;
      res.status(400).json({ code: error.code });
    });
    await request(app)
      .post('/upload')
      .field('name', 'fixture')
      .attach('file', Buffer.from('ok'), 'a.txt')
      .expect(200, { name: 'fixture', file: 'ok' });
    await request(app)
      .post('/upload')
      .attach('file', Buffer.alloc(17), 'a.txt')
      .expect(400, { code: 'LIMIT_FILE_SIZE' });
  });
  it('retains the parser APIs used by the existing application and tooling', () => {
    expect(qs.parse('limit=20&filter[account]=ak_abc')).toEqual({
      limit: '20',
      filter: { account: 'ak_abc' },
    });
    const yaml3 = createRequire(require.resolve('@istanbuljs/load-nyc-config'))(
      'js-yaml',
    );
    const yaml4 = createRequire(require.resolve('cosmiconfig'))('js-yaml');
    expect(yaml3.safeLoad('settings: [one, two]')).toEqual({
      settings: ['one', 'two'],
    });
    expect(yaml4.load('settings: [one, two]')).toEqual({
      settings: ['one', 'two'],
    });
    expect(uri.serialize(uri.parse('https://example.com/path?x=1'))).toBe(
      'https://example.com/path?x=1',
    );
  });
});
