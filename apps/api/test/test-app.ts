import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type ApiEnv, loadApiEnv } from '@wanderly/config';
import type { Response } from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { REFRESH_COOKIE } from '../src/auth/refresh-cookie';
import { ENV } from '../src/config/config.module';
import { EMAIL_PROVIDER, type EmailMessage, type EmailProvider } from '../src/email/email-provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { testDatabaseUrl } from './database';
import { generateTestKeyPair, type TestKeyPair } from './keys';

/** Captures outgoing mail. Email is the one boundary faked: Postgres is real. */
export class CapturingEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  to(address: string): EmailMessage[] {
    return this.sent.filter((message) => message.to === address);
  }

  /** The token from the most recent verification link sent to an address. */
  verificationTokenFor(address: string): string {
    const link = this.to(address)
      .map((message) => /[?&]token=([\w-]+)/.exec(message.text)?.[1])
      .filter((token): token is string => token !== undefined)
      .at(-1);
    if (!link) throw new Error(`No verification email sent to ${address}`);
    return link;
  }
}

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  emails: CapturingEmailProvider;
  env: ApiEnv;
  keys: TestKeyPair;
}

let keys: TestKeyPair | undefined;

export async function createTestApp(): Promise<TestApp> {
  keys ??= generateTestKeyPair();
  const env = loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: 'redis://localhost:6379',
    KAFKA_BROKERS: 'localhost:9092',
    JWT_PRIVATE_KEY: keys.privateKeyBase64,
    JWT_PUBLIC_KEY: keys.publicKeyBase64,
    APP_URL: 'http://wanderly.test',
  });
  const emails = new CapturingEmailProvider();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(EMAIL_PROVIDER)
    .useValue(emails)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  return { app, prisma: app.get(PrismaService), emails, env, keys };
}

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE users CASCADE');
}

/** The refresh token value from a response's Set-Cookie header, if any. */
export function refreshCookieOf(res: Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((value) => value.startsWith(`${REFRESH_COOKIE}=`));
  const value = cookie?.split(';')[0]?.slice(REFRESH_COOKIE.length + 1);
  return value || undefined;
}

export function withRefreshCookie(token: string): [string, string] {
  return ['Cookie', `${REFRESH_COOKIE}=${token}`];
}
