import { createHash, randomBytes } from 'node:crypto';

/** 256 bits from the CSPRNG, URL-safe so it can sit in a link or a cookie. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only this hash is stored. SHA-256 (not Argon2) is enough because the token is
 * already high-entropy random: there is no dictionary to attack.
 */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
