import type { CookieOptions } from 'express';

export const REFRESH_COOKIE = 'wanderly_refresh';

/**
 * HttpOnly: unreadable by scripts, so XSS cannot steal it.
 * SameSite=Strict: never sent on cross-site requests, which blocks CSRF.
 * Path: only sent to the auth endpoints, not on every API call.
 */
export function refreshCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'strict', path: '/api/v1/auth' };
}
