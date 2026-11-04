import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { writeFile } from 'node:fs/promises';
import { ShortsLegacyImportModule } from './shorts-legacy-import.module';
import { ShortsLegacyImportService } from './shorts-legacy-import.service';
import { shortsConfigJson } from './shorts-release';

async function bootstrap() {
  const [mode, configFile, snapshotFile] = process.argv.slice(2);
  if (
    !['snapshot', 'verify', 'import', 'activate'].includes(mode) ||
    !snapshotFile?.startsWith('/')
  )
    throw new Error(
      'Use snapshot|verify|import|activate with absolute configuration and snapshot paths',
    );
  const app = await NestFactory.createApplicationContext(
    ShortsLegacyImportModule,
    { logger: ['error'] },
  );
  try {
    const service = app.get(ShortsLegacyImportService);
    service.progress = (message) => console.error(message);
    await service.initialize(
      await shortsConfigJson(configFile),
      ['import', 'activate'].includes(mode)
        ? process.env.SHORTS_MIGRATION_KEY_FILE
        : undefined,
    );
    if (mode === 'snapshot') {
      const snapshot = await service.snapshot();
      await writeFile(snapshotFile, JSON.stringify(snapshot, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      console.log(
        JSON.stringify({
          contract: snapshot.destination,
          cutoff: snapshot.cutoff,
          videos: snapshot.videos.length,
          likes: snapshot.videos.reduce((n, v) => n + v.likes.length, 0),
          commitment: snapshot.commitment,
        }),
      );
    } else {
      const snapshot = await shortsConfigJson(snapshotFile);
      const result =
        mode === 'verify'
          ? await service.verify(snapshot)
          : await service.import(snapshot, mode === 'activate');
      console.log(
        JSON.stringify(
          mode === 'verify'
            ? { verified: true, commitment: snapshot.commitment }
            : result,
          (_, v) => (typeof v === 'bigint' ? v.toString() : v),
        ),
      );
    }
  } finally {
    await app.close();
  }
}
void bootstrap().catch((error) => {
  console.error(
    error instanceof Error ? error.stack : 'Legacy migration failed',
  );
  process.exitCode = 1;
});
