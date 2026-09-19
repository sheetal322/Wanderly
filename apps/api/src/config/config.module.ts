import { Global, Module } from '@nestjs/common';
import { loadEnv, type Env } from '@wanderly/config';

export const ENV = Symbol('WANDERLY_ENV');

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
