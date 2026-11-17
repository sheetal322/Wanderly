import { createHmac } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { loadApiEnv } from '@wanderly/config';
import jwt from 'jsonwebtoken';
import { generateTestKeyPair } from '../../test/keys';
import { AccessTokenService } from './access-token.service';

const keys = generateTestKeyPair();
const env = loadApiEnv({
  DATABASE_URL: 'postgres://localhost/unused',
  REDIS_URL: 'redis://localhost',
  KAFKA_BROKERS: 'localhost:9092',
  JWT_PRIVATE_KEY: keys.privateKeyBase64,
  JWT_PUBLIC_KEY: keys.publicKeyBase64,
});
const service = new AccessTokenService(env);
const claims = { issuer: 'wanderly', audience: 'wanderly-api', subject: 'user-1' };

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('AccessTokenService', () => {
  it('round-trips a signed token to its user', () => {
    const { accessToken, expiresIn } = service.sign('user-1');
    expect(expiresIn).toBe(900);
    expect(service.verify(accessToken)).toEqual({ userId: 'user-1' });
  });

  it('signs with RS256', () => {
    const { accessToken } = service.sign('user-1');
    expect(jwt.decode(accessToken, { complete: true })?.header.alg).toBe('RS256');
  });

  it('rejects a token signed by a different key', () => {
    const other = generateTestKeyPair();
    const forged = jwt.sign({}, other.privateKeyPem, { algorithm: 'RS256', ...claims });
    expect(() => service.verify(forged)).toThrow(UnauthorizedException);
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ exp: Math.floor(Date.now() / 1000) - 10 }, keys.privateKeyPem, {
      algorithm: 'RS256',
      ...claims,
    });
    expect(() => service.verify(expired)).toThrow(UnauthorizedException);
  });

  it('rejects a token for another audience', () => {
    const token = jwt.sign({}, keys.privateKeyPem, {
      algorithm: 'RS256',
      ...claims,
      audience: 'other',
    });
    expect(() => service.verify(token)).toThrow(UnauthorizedException);
  });

  it('rejects an unsigned "alg: none" token', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
      sub: 'user-1',
      iss: 'wanderly',
      aud: 'wanderly-api',
      exp: now + 60,
    })}.`;
    expect(() => service.verify(token)).toThrow(UnauthorizedException);
  });

  it('rejects an HS256 token keyed with the public key (algorithm confusion)', () => {
    // The public key is public. If the verifier let the token pick HS256, anyone
    // could mint tokens by HMAC-signing with it.
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({
      sub: 'attacker',
      iss: 'wanderly',
      aud: 'wanderly-api',
      exp: now + 60,
    })}`;
    const signature = createHmac('sha256', keys.publicKeyPem).update(unsigned).digest('base64url');
    expect(() => service.verify(`${unsigned}.${signature}`)).toThrow(UnauthorizedException);
  });
});
