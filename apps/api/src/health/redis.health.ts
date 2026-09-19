import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Env } from '@wanderly/config';
import Redis from 'ioredis';
import { ENV } from '../config/config.module';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisHealthIndicator.name);
  private readonly client: Redis;

  constructor(@Inject(ENV) env: Env) {
    super();
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      // A health check must fail fast rather than queue behind reconnect attempts.
      enableOfflineQueue: false,
      // No background reconnect loop: isHealthy() reconnects explicitly on the
      // next probe. Avoids a retry timer that outlives the check.
      retryStrategy: () => null,
    });

    // Same reasoning as the Postgres pool: an unhandled 'error' event would
    // terminate the process during a Redis blip.
    this.client.on('error', (error: Error) => {
      this.logger.warn(`Redis client error: ${error.message}`);
    });
  }

  async isHealthy(key = 'redis'): Promise<HealthIndicatorResult> {
    try {
      if (this.client.status === 'wait' || this.client.status === 'end') {
        await this.client.connect();
      }
      await this.client.ping();
      return this.getStatus(key, true);
    } catch (error) {
      // Must throw, not just return a down status: Terminus only fails the
      // aggregate readiness check (503) when an indicator throws.
      const result = this.getStatus(key, false, { message: (error as Error).message });
      throw new HealthCheckError('Redis is unreachable', result);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.client.disconnect();
  }
}
