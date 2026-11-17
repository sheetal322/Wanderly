import request from 'supertest';
import {
  createTestApp,
  refreshCookieOf,
  resetDatabase,
  type TestApp,
  withRefreshCookie,
} from '../../test/test-app';

const EMAIL = 'ada@example.com';
const PASSWORD = 'correct horse battery staple';
const TIMEZONE = 'Europe/Berlin';

describe('Auth (integration)', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.emails.sent.length = 0;
  });

  function register(email = EMAIL, password = PASSWORD) {
    return http().post('/api/v1/auth/register').send({ email, password, timezone: TIMEZONE });
  }

  async function registerAndVerify(email = EMAIL, password = PASSWORD) {
    await register(email, password).expect(202);
    await http()
      .post('/api/v1/auth/verify-email')
      .send({ token: t.emails.verificationTokenFor(email.toLowerCase()) })
      .expect(204);
  }

  function login(email = EMAIL, password = PASSWORD) {
    return http().post('/api/v1/auth/login').send({ email, password });
  }

  /** Logs in and returns the first refresh token of a new family. */
  async function loginForRefreshToken(): Promise<string> {
    const res = await login().expect(200);
    const token = refreshCookieOf(res);
    if (!token) throw new Error('Login set no refresh cookie');
    return token;
  }

  describe('registration and verification', () => {
    it('registers, blocks login until verified, then logs in', async () => {
      await register().expect(202);

      const user = await t.prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.emailVerifiedAt).toBeNull();

      await login().expect(403);

      await http()
        .post('/api/v1/auth/verify-email')
        .send({ token: t.emails.verificationTokenFor(EMAIL) })
        .expect(204);

      const res = await login().expect(200);
      expect(res.body).toEqual({
        accessToken: expect.any(String),
        tokenType: 'Bearer',
        expiresIn: 900,
      });

      const me = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
      expect(me.body).toMatchObject({ email: EMAIL, timezone: TIMEZONE });
    });

    it('stores only a hash of the verification token', async () => {
      await register().expect(202);
      const token = t.emails.verificationTokenFor(EMAIL);

      const rows = await t.prisma.emailVerificationToken.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenHash).not.toContain(token);
      expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('makes a verification link single-use', async () => {
      await register().expect(202);
      const token = t.emails.verificationTokenFor(EMAIL);

      await http().post('/api/v1/auth/verify-email').send({ token }).expect(204);
      await http().post('/api/v1/auth/verify-email').send({ token }).expect(400);
    });

    it('rejects an expired verification link', async () => {
      await register().expect(202);
      await t.prisma.emailVerificationToken.updateMany({ data: { expiresAt: new Date(0) } });

      await http()
        .post('/api/v1/auth/verify-email')
        .send({ token: t.emails.verificationTokenFor(EMAIL) })
        .expect(400);
    });

    it('treats email addresses case-insensitively', async () => {
      await registerAndVerify('Ada@Example.COM');
      await login('ADA@example.com').expect(200);
      expect(await t.prisma.user.count()).toBe(1);
    });

    it('answers a duplicate registration exactly like a new one, and emails the owner', async () => {
      await registerAndVerify();
      t.emails.sent.length = 0;

      const res = await register(EMAIL, 'some other password').expect(202);
      expect(res.body).toEqual({ message: expect.any(String) });

      expect(await t.prisma.user.count()).toBe(1);
      expect(t.emails.to(EMAIL).map((m) => m.subject)).toEqual([
        'You already have a Wanderly account',
      ]);
      // The existing account's password is untouched.
      await login().expect(200);
    });

    it('lets a later registration of an unverified address invalidate earlier links', async () => {
      // An attacker pre-registers the victim's address with their own password.
      await register(EMAIL, 'attacker password 123').expect(202);
      const attackerLink = t.emails.verificationTokenFor(EMAIL);

      // The real owner registers. Only their link may verify the account.
      await register(EMAIL, PASSWORD).expect(202);
      const ownerLink = t.emails.verificationTokenFor(EMAIL);
      expect(ownerLink).not.toBe(attackerLink);

      await http().post('/api/v1/auth/verify-email').send({ token: attackerLink }).expect(400);
      await http().post('/api/v1/auth/verify-email').send({ token: ownerLink }).expect(204);

      await login(EMAIL, 'attacker password 123').expect(401);
      await login(EMAIL, PASSWORD).expect(200);
    });

    it('resends verification without revealing whether an account exists', async () => {
      await register().expect(202);
      const first = t.emails.verificationTokenFor(EMAIL);

      await http().post('/api/v1/auth/resend-verification').send({ email: EMAIL }).expect(202);
      await http()
        .post('/api/v1/auth/resend-verification')
        .send({ email: 'nobody@example.com' })
        .expect(202);

      expect(t.emails.to('nobody@example.com')).toHaveLength(0);
      // Only the newest link works.
      await http().post('/api/v1/auth/verify-email').send({ token: first }).expect(400);
      await http()
        .post('/api/v1/auth/verify-email')
        .send({ token: t.emails.verificationTokenFor(EMAIL) })
        .expect(204);
    });

    it.each([
      ['an invalid timezone', { email: EMAIL, password: PASSWORD, timezone: 'Mars/Olympus' }],
      [
        'a fixed offset instead of a timezone',
        { email: EMAIL, password: PASSWORD, timezone: '+01:00' },
      ],
      ['a short password', { email: EMAIL, password: 'short', timezone: TIMEZONE }],
      ['an invalid email', { email: 'not-an-email', password: PASSWORD, timezone: TIMEZONE }],
      ['an unknown field', { email: EMAIL, password: PASSWORD, timezone: TIMEZONE, admin: true }],
    ])('rejects %s', async (_case, body) => {
      await http().post('/api/v1/auth/register').send(body).expect(400);
      expect(await t.prisma.user.count()).toBe(0);
    });
  });

  describe('login', () => {
    it('gives the same answer for a wrong password and an unknown email', async () => {
      await registerAndVerify();

      const wrongPassword = await login(EMAIL, 'wrong password!!').expect(401);
      const unknownEmail = await login('nobody@example.com', PASSWORD).expect(401);
      expect(wrongPassword.body).toEqual(unknownEmail.body);
    });

    it('sets the refresh token as an HttpOnly, SameSite=Strict cookie scoped to /api/v1/auth', async () => {
      await registerAndVerify();
      const res = await login().expect(200);

      const cookie = (res.headers['set-cookie'] as unknown as string[])[0] ?? '';
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
      expect(res.body).not.toHaveProperty('refreshToken');

      const [row] = await t.prisma.refreshToken.findMany();
      expect(row?.tokenHash).not.toBe(refreshCookieOf(res));
    });
  });

  describe('refresh token rotation', () => {
    beforeEach(async () => {
      await registerAndVerify();
    });

    it('rotates: returns a new access token and a new refresh token', async () => {
      const first = await loginForRefreshToken();

      const res = await http()
        .post('/api/v1/auth/refresh')
        .set(...withRefreshCookie(first))
        .expect(200);
      const second = refreshCookieOf(res);

      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(second).toBeDefined();
      expect(second).not.toBe(first);

      const tokens = await t.prisma.refreshToken.findMany();
      expect(new Set(tokens.map((token) => token.familyId)).size).toBe(1);
    });

    it('revokes the whole family when a used refresh token is presented again', async () => {
      const stolen = await loginForRefreshToken();

      // The legitimate client rotates first...
      const rotated = await http()
        .post('/api/v1/auth/refresh')
        .set(...withRefreshCookie(stolen))
        .expect(200);
      const current = refreshCookieOf(rotated) as string;

      // ...then the thief replays the old token. Reuse detected.
      await http()
        .post('/api/v1/auth/refresh')
        .set(...withRefreshCookie(stolen))
        .expect(401);

      // The legitimate client's current token is now dead too: everyone re-logs in.
      await http()
        .post('/api/v1/auth/refresh')
        .set(...withRefreshCookie(current))
        .expect(401);

      const live = await t.prisma.refreshToken.count({ where: { revokedAt: null } });
      expect(live).toBe(0);
    });

    it('lets exactly one of two concurrent refreshes with the same token succeed', async () => {
      const token = await loginForRefreshToken();

      const results = await Promise.all([
        http()
          .post('/api/v1/auth/refresh')
          .set(...withRefreshCookie(token)),
        http()
          .post('/api/v1/auth/refresh')
          .set(...withRefreshCookie(token)),
      ]);

      expect(results.map((res) => res.status).sort()).toEqual([200, 401]);
      // Two holders of one token is reuse, so the winner's new token is revoked as well.
      expect(await t.prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
    });

    it('does not touch other sessions of the same user', async () => {
      const laptop = await loginForRefreshToken();
      const phone = await loginForRefreshToken();

      await http()
        .post('/api/v1/auth/refresh')
        .set(...withRefreshCookie(laptop))
        .expect(200);
      await http()
        .post('/api/v1/auth/refresh')
        .set(...withRefreshCookie(laptop))
        .expect(401);

      await http()
        .post('/api/v1/auth/refresh')
        .set(...withRefreshCookie(phone))
        .expect(200);
    });

    it('rejects an expired refresh token', async () => {
      const token = await loginForRefreshToken();
      await t.prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

      await http()
        .post('/api/v1/auth/refresh')
        .set(...withRefreshCookie(token))
        .expect(401);
    });

    it('rejects a missing or unknown refresh token', async () => {
      await http().post('/api/v1/auth/refresh').expect(401);
      await http()
        .post('/api/v1/auth/refresh')
        .set(...withRefreshCookie('made-up'))
        .expect(401);
    });
  });

  describe('logout', () => {
    it('revokes the session and clears the cookie', async () => {
      await registerAndVerify();
      const token = await loginForRefreshToken();

      const res = await http()
        .post('/api/v1/auth/logout')
        .set(...withRefreshCookie(token))
        .expect(204);
      expect(refreshCookieOf(res)).toBeUndefined();
      expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(
        /Expires=Thu, 01 Jan 1970/,
      );

      await http()
        .post('/api/v1/auth/refresh')
        .set(...withRefreshCookie(token))
        .expect(401);
    });

    it('succeeds without a cookie', async () => {
      await http().post('/api/v1/auth/logout').expect(204);
    });
  });

  describe('route protection', () => {
    it('requires a bearer token by default', async () => {
      await http().get('/api/v1/me').expect(401);
      await http().get('/api/v1/me').set('Authorization', 'Bearer nonsense').expect(401);
    });

    it('rejects an access token for a deleted user', async () => {
      await registerAndVerify();
      const { accessToken } = (await login().expect(200)).body;
      await t.prisma.user.deleteMany();

      await http().get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
    });

    it('keeps liveness public', async () => {
      await http().get('/healthz').expect(200);
    });
  });
});
