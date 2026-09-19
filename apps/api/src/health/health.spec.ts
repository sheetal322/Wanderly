import { HealthCheckError } from '@nestjs/terminus';
import type { Env } from '@wanderly/config';
import { PostgresHealthIndicator } from './postgres.health';
import { RedisHealthIndicator } from './redis.health';

/**
 * These assert the invariant that an unreachable dependency makes readiness
 * *fail*. Returning a `down` status without throwing leaves the aggregate check
 * at 200, which silently keeps a broken instance in a load balancer rotation.
 */
const unreachable: Env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  API_PORT: 3000,
  // Port 1 is reserved and never listening, so these fail fast.
  DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/nothing',
  REDIS_URL: 'redis://127.0.0.1:1',
  KAFKA_BROKERS: ['127.0.0.1:1'],
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: 1,
  MAIL_FROM: 'no-reply@wanderly.dev',
};

describe('PostgresHealthIndicator', () => {
  it('throws when Postgres is unreachable', async () => {
    const indicator = new PostgresHealthIndicator(unreachable);
    await expect(indicator.isHealthy()).rejects.toThrow(HealthCheckError);
    await indicator.onApplicationShutdown();
  });
});

describe('RedisHealthIndicator', () => {
  it('throws when Redis is unreachable', async () => {
    const indicator = new RedisHealthIndicator(unreachable);
    await expect(indicator.isHealthy()).rejects.toThrow(HealthCheckError);
    await indicator.onApplicationShutdown();
  });
});
