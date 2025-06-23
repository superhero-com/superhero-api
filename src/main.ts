import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { DEBUG_ENABLED } from './configs';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: DEBUG_ENABLED
      ? ['error', 'warn', 'log', 'debug', 'verbose']
      : ['error'],
  });

  const config = new DocumentBuilder()
    .setTitle('WORD CRAFT Scan')
    .setDescription('The WORD CRAFT Scan API')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  app.enableCors();
  app.setGlobalPrefix('api');
  await app.listen(process.env.APP_PORT ?? 3000);
}
void bootstrap();
