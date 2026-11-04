import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  ProfileMediaKeyModule,
  ProfileMediaOperations,
  ProfileMediaOperationsModule,
} from './profile-media-operations.module';

async function main() {
  const command = process.argv[2];
  if (
    !['key', 'status', 'register', 'deploy', 'cleanup-policy'].includes(command)
  )
    throw new Error('Use key, status, register, deploy, or cleanup-policy');
  const app = await NestFactory.createApplicationContext(
    ['key', 'cleanup-policy'].includes(command)
      ? ProfileMediaKeyModule
      : ProfileMediaOperationsModule,
    { logger: false },
  );
  try {
    const operation = app.get(ProfileMediaOperations);
    console.log(
      JSON.stringify(
        command === 'cleanup-policy'
          ? await operation.cleanupPolicy()
          : command === 'key'
            ? await operation.key()
            : command === 'deploy'
              ? await operation.deploy()
              : await operation.providers(command === 'register'),
      ),
    );
  } finally {
    await app.close();
  }
}
void main().catch(() => {
  console.error(
    'Profile image setup failed. Check configuration, credential permissions, provider ownership and funding.',
  );
  process.exitCode = 1;
});
