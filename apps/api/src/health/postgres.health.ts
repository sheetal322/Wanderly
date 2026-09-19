import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Env } from '@wanderly/config';
import { Pool } from 'pg';
import { ENV } from '../config/config.module';

@Injectable()
export class PostgresHealthIndicator extends HealthIndicator implements OnApplicationShutdown {
  private readonly logger = new Logger(PostgresHealthIndicator.name);
  private readonly pool: Pool;

  constructor(@Inject(ENV) env: Env) {
    super();
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 2_000,
    });

    // pg emits 'error' when an *idle* connection dies (Postgres restart, network
    // blip). An unhandled 'error' event terminates the process, so a brief
    // database outage would kill the API instead of just failing readiness.
    this.pool.on('error', (error) => {
      this.logger.warn(`Idle Postgres client error: ${error.message}`);
    });
  }

  async isHealthy(key = 'postgres'): Promise<HealthIndicatorResult> {
    try {
      await this.pool.query('SELECT 1');
      return this.getStatus(key, true);
    } catch (error) {
      // Must throw, not just return a down status: Terminus only fails the
      // aggregate readiness check (503) when an indicator throws.
      const result = this.getStatus(key, false, { message: (error as Error).message });
      throw new HealthCheckError('Postgres is unreachable', result);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
