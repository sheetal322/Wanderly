import { Global, Module } from '@nestjs/common';
import { loadApiEnv, type ApiEnv } from '@wanderly/config';

export const ENV = Symbol('WANDERLY_ENV');

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): ApiEnv => loadApiEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
