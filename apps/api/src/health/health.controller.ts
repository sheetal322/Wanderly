import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { PostgresHealthIndicator } from './postgres.health';
import { RedisHealthIndicator } from './redis.health';

@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PostgresHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /**
   * Liveness: is the process itself alive? Deliberately checks no dependencies —
   * a container should not be restarted because Postgres is briefly unreachable.
   */
  @Get('healthz')
  liveness(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  /**
   * Readiness: can this instance serve traffic? Checks dependencies, so a
   * load balancer stops sending requests while Postgres or Redis is down.
   */
  @Get('readyz')
  @HealthCheck()
  readiness() {
    return this.health.check([() => this.postgres.isHealthy(), () => this.redis.isHealthy()]);
  }
}
