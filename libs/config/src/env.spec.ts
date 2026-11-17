import { generateKeyPairSync } from 'node:crypto';
import { loadApiEnv, loadEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://wanderly:wanderly@localhost:5432/wanderly',
  REDIS_URL: 'redis://localhost:6379',
  KAFKA_BROKERS: 'localhost:9092',
};

describe('loadEnv', () => {
  it('applies defaults for optional values', () => {
    const env = loadEnv(valid);
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(3000);
    expect(env.SMTP_PORT).toBe(1025);
  });

  it('splits a comma-separated broker list', () => {
    const env = loadEnv({ ...valid, KAFKA_BROKERS: 'a:9092, b:9092' });
    expect(env.KAFKA_BROKERS).toEqual(['a:9092', 'b:9092']);
  });

  it('throws naming every missing or invalid variable', () => {
    expect(() => loadEnv({ REDIS_URL: 'not-a-url' })).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ REDIS_URL: 'not-a-url' })).toThrow(/REDIS_URL/);
  });
});

describe('loadApiEnv', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const keys = {
    JWT_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
    JWT_PUBLIC_KEY: Buffer.from(publicKey).toString('base64'),
  };

  it('decodes base64 PEM keys and applies auth defaults', () => {
    const env = loadApiEnv({ ...valid, ...keys });
    expect(env.JWT_PRIVATE_KEY).toBe(privateKey);
    expect(env.JWT_PUBLIC_KEY).toBe(publicKey);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(30);
  });

  it('requires the key pair', () => {
    expect(() => loadApiEnv(valid)).toThrow(/JWT_PRIVATE_KEY/);
  });

  it('rejects a key that is not a base64 PEM, or the wrong half of the pair', () => {
    expect(() => loadApiEnv({ ...valid, ...keys, JWT_PRIVATE_KEY: 'not-a-key' })).toThrow(
      /JWT_PRIVATE_KEY/,
    );
    expect(() => loadApiEnv({ ...valid, ...keys, JWT_PRIVATE_KEY: keys.JWT_PUBLIC_KEY })).toThrow(
      /JWT_PRIVATE_KEY/,
    );
  });

  it('leaves the base schema free of the signing key', () => {
    expect(loadEnv({ ...valid, ...keys })).not.toHaveProperty('JWT_PRIVATE_KEY');
  });
});
