import { loadEnv } from './env';

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
