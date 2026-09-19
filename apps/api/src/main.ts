import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '@wanderly/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // Validate before Nest starts: a bad environment should fail here, loudly.
  const env = loadEnv();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });

  // Lets Postgres/Redis pools close cleanly and in-flight requests finish.
  app.enableShutdownHooks();

  await app.listen(env.API_PORT, '0.0.0.0');
}

void bootstrap();
