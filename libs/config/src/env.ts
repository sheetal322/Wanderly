import { z } from 'zod';

/**
 * One schema for every service. Each process validates the whole environment at
 * boot and crashes immediately if something is missing — a misconfigured worker
 * should die on startup, not three hours later on the first message it handles.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // API
  API_PORT: z.coerce.number().int().positive().default(3000),

  // Infrastructure
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  KAFKA_BROKERS: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((broker) => broker.trim())),

  // Email (Mailpit locally; a real provider when deployed)
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  MAIL_FROM: z.string().email().default('no-reply@wanderly.dev'),
});

export type Env = z.infer<typeof envSchema>;
export type NodeEnv = Env['NODE_ENV'];

/**
 * A PEM key passed base64-encoded, so it fits on one line of a .env file or a
 * compose environment block. Decoded here so a malformed key fails at boot.
 */
const base64Pem = (kind: 'PRIVATE' | 'PUBLIC') =>
  z
    .string()
    .min(1)
    .transform((value) => Buffer.from(value, 'base64').toString('utf8'))
    .refine((pem) => pem.includes(`-----BEGIN ${kind} KEY-----`), {
      message: `must be a base64-encoded PEM ${kind.toLowerCase()} key (run \`npm run keys:generate\`)`,
    });

/**
 * The API additionally holds the JWT signing key. Only the API mints tokens, so
 * no other service's environment should ever contain the private key.
 */
export const apiEnvSchema = envSchema.extend({
  JWT_PRIVATE_KEY: base64Pem('PRIVATE'),
  JWT_PUBLIC_KEY: base64Pem('PUBLIC'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  // Where links in emails point (the web app, from Phase 10).
  APP_URL: z.string().url().default('http://localhost:5173'),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return parseEnv(envSchema, source);
}

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  return parseEnv(apiEnvSchema, source);
}

function parseEnv<Schema extends z.ZodTypeAny>(
  schema: Schema,
  source: NodeJS.ProcessEnv,
): z.infer<Schema> {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return parsed.data;
}
