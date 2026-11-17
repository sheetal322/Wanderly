import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { ApiEnv } from '@wanderly/config';
import { PrismaClient } from '@wanderly/db';
import { ENV } from '../config/config.module';

@Injectable()
export class PrismaService extends PrismaClient implements OnApplicationShutdown {
  constructor(@Inject(ENV) env: ApiEnv) {
    // Connects lazily on the first query, so a database that is down at boot
    // fails readiness rather than crashing the process.
    super({ datasourceUrl: env.DATABASE_URL });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
