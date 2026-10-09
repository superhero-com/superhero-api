import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { Request, Response, NextFunction } from 'express';

@Catch()
class LocalErrorFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    response
      .status(error instanceof HttpException ? error.getStatus() : 400)
      .json({ message: error.message.slice(0, 500) });
  }
}
async function bootstrap() {
  if (
    process.env.ENABLE_SHORTS !== 'true' ||
    process.env.SHORTS_TESTNET_MVP !== '1' ||
    process.env.NODE_ENV === 'production'
  )
    throw new Error('Local Shorts preview is disabled');
  const { ShortsTestnetModule } = await import('./shorts.module');
  const app = await NestFactory.create(ShortsTestnetModule);
  const origins = ['http://localhost:5180', 'http://127.0.0.1:5180'];
  app.enableCors({
    origin: origins,
    allowedHeaders: ['Content-Type', 'X-Shorts-Local', 'Authorization'],
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Docker Desktop reaches this loopback server via its host alias. Only the
    // public playback descriptor is exposed under that Host, never Studio/auth.
    const streamingLookup =
      req.headers.host === 'host.docker.internal:3334' &&
      req.method === 'GET' &&
      /^\/api\/shorts\/playback\/[a-zA-Z0-9-]{1,80}$/.test(req.path);
    if (
      !['localhost:3334', '127.0.0.1:3334'].includes(req.headers.host ?? '') &&
      !streamingLookup
    )
      return res.status(403).end();
    if (req.headers.origin && !origins.includes(req.headers.origin))
      return res.status(403).end();
    if (req.method === 'POST' && req.headers['x-shorts-local'] !== '1')
      return res.status(403).json({ message: 'Local preview header required' });
    next();
  });
  app.enableShutdownHooks();
  app.useGlobalFilters(new LocalErrorFilter());
  app.setGlobalPrefix('api');
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Superhero Shorts testnet MVP')
        .setVersion('0.1')
        .build(),
    ),
  );
  await app.listen(3334, '127.0.0.1');
  console.log(
    'Shorts testnet API ready at http://127.0.0.1:3334/api/shorts/config',
  );
}
void bootstrap();
