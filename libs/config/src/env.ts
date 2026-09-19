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

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return parsed.data;
}
