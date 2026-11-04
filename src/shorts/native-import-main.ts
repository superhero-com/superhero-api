import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { writeFile } from 'node:fs/promises';
import { ShortsNativeImportModule } from './shorts-native-import.module';
import {
  ShortsNativeImportService,
  NativeSnapshot,
  readShortsMigrationSnapshot,
} from './shorts-native-import.service';
import { shortsConfigJson } from './shorts-release';

async function bootstrap() {
  const [mode, configFile, snapshotFile] = process.argv.slice(2);
  if (
    ![
      'prepare',
      'freeze',
      'snapshot',
      'copy',
      'activate',
      'verify',
      'reconcile',
    ].includes(mode) ||
    !configFile?.startsWith('/') ||
    !snapshotFile?.startsWith('/')
  )
    throw new Error(
      'Use prepare|freeze|snapshot|copy|activate|verify|reconcile with absolute configuration and snapshot paths',
    );
  const app = await NestFactory.createApplicationContext(
    ShortsNativeImportModule,
    { logger: ['error'] },
  );
  try {
    const service = app.get(ShortsNativeImportService);
    const writes = [
      'prepare',
      'freeze',
      'copy',
      'activate',
      'reconcile',
    ].includes(mode);
    if (
      writes &&
      (!process.env.SHORTS_MIGRATION_KEY_FILE ||
        !process.env.SHORTS_MIGRATION_JOURNAL_FILE)
    )
      throw new Error('Owner key and private durable journal required');
    await service.initialize(
      await shortsConfigJson(configFile),
      writes ? process.env.SHORTS_MIGRATION_KEY_FILE : undefined,
      writes ? process.env.SHORTS_MIGRATION_JOURNAL_FILE : undefined,
    );
    let result: unknown;
    if (mode === 'prepare') result = await service.prepare();
    else if (mode === 'freeze') result = await service.freezeAndSeal();
    else if (mode === 'reconcile') result = await service.reconcile();
    else if (mode === 'snapshot') {
      const snapshot = await service.snapshot();
      await writeFile(snapshotFile, JSON.stringify(snapshot, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      result = {
        commitment: snapshot.commitment,
        totals: snapshot.totals,
        cutoff: snapshot.cutoff,
      };
    } else {
      const snapshot = (await readShortsMigrationSnapshot(
        snapshotFile,
      )) as NativeSnapshot;
      result =
        mode === 'copy'
          ? await service.copy(snapshot)
          : mode === 'activate'
            ? await service.activate(snapshot)
            : await service.verifyDestination(snapshot);
    }
    console.log(JSON.stringify({ mode, passed: true, result }));
  } finally {
    await app.close();
  }
}
void bootstrap().catch(() => {
  console.error(
    'Native migration stopped; preserve and reconcile the private journal before proceeding.',
  );
  process.exitCode = 1;
});
