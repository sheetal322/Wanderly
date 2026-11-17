import { type INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';

/**
 * HTTP configuration shared by main.ts and the integration tests, so the tests
 * exercise the same prefix, validation and cookie handling as production.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Unknown fields are a client bug worth surfacing, not silently dropping.
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
