import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';

const CORRELATION_HEADER = 'x-correlation-id';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // The correlation id enters here and will later be carried through Kafka
        // headers so one notification can be traced API → dispatcher → worker.
        genReqId: (req, res) => {
          const existing = req.headers[CORRELATION_HEADER];
          const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
          res.setHeader(CORRELATION_HEADER, id);
          return id;
        },
        autoLogging: { ignore: (req) => req.url === '/healthz' },
        transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
      },
    }),
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    EventsModule,
  ],
})
export class AppModule {}
