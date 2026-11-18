import request from 'supertest';
import {
  createSignedInUser,
  createTestApp,
  resetDatabase,
  type TestApp,
} from '../../test/test-app';

const BIRTHDAY = {
  title: 'Mum’s birthday',
  startsAtLocal: '2030-06-15T09:00',
  timezone: 'Europe/Berlin',
  rrule: 'FREQ=YEARLY',
};

describe('Events (integration)', () => {
  let t: TestApp;
  let auth: [string, string];
  let userId: string;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    ({ auth, userId } = await createSignedInUser(t, 'ada@example.com'));
  });

  const create = (body: object = BIRTHDAY, as = auth) =>
    http()
      .post('/api/v1/events')
      .set(...as)
      .send(body);

  async function createId(body: object = BIRTHDAY, as = auth): Promise<string> {
    return (await create(body, as).expect(201)).body.id;
  }

  describe('create', () => {
    it('creates a recurring event and returns it', async () => {
      const res = await create().expect(201);
      expect(res.body).toEqual({
        id: expect.any(String),
        title: 'Mum’s birthday',
        description: null,
        startsAtLocal: '2030-06-15T09:00:00',
        timezone: 'Europe/Berlin',
        rrule: 'FREQ=YEARLY',
        status: 'ACTIVE',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it('stores the start as wall-clock time, not an instant', async () => {
      const id = await createId();
      const [row] = await t.prisma.$queryRaw<{ value: string }[]>`
        SELECT starts_at_local::text AS value FROM events WHERE id = ${id}::uuid`;
      expect(row?.value).toBe('2030-06-15 09:00:00');
    });

    it('creates a one-off event when there is no rule', async () => {
      const res = await create({ ...BIRTHDAY, rrule: undefined }).expect(201);
      expect(res.body.rrule).toBeNull();
    });

    it('strips an "RRULE:" prefix', async () => {
      const res = await create({ ...BIRTHDAY, rrule: 'RRULE:FREQ=WEEKLY;BYDAY=TU' }).expect(201);
      expect(res.body.rrule).toBe('FREQ=WEEKLY;BYDAY=TU');
    });

    it.each([
      ['a fixed offset for a time zone', { timezone: '+01:00' }, /IANA/],
      ['an offset on the start', { startsAtLocal: '2030-06-15T09:00+02:00' }, /date-time/],
      ['an impossible date', { startsAtLocal: '2030-02-30T09:00' }, /date-time/],
      ['a sub-daily rule', { rrule: 'FREQ=SECONDLY' }, /DAILY, WEEKLY/],
      ['a rule that never occurs', { rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30' }, /never/],
      ['an unparseable rule', { rrule: 'every tuesday' }, /RRULE/],
      ['an empty title', { title: '   ' }, /title/],
      ['an unknown field', { colour: 'red' }, /colour/],
    ])('rejects %s', async (_case, overrides, message) => {
      const res = await create({ ...BIRTHDAY, ...overrides }).expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(message);
      expect(await t.prisma.event.count()).toBe(0);
    });

    it('requires authentication', async () => {
      await http().post('/api/v1/events').send(BIRTHDAY).expect(401);
    });
  });

  describe('ownership', () => {
    it("makes another user's event indistinguishable from a missing one", async () => {
      const id = await createId();
      const eve = await createSignedInUser(t, 'eve@example.com');

      await http()
        .get(`/api/v1/events/${id}`)
        .set(...eve.auth)
        .expect(404);
      await http()
        .patch(`/api/v1/events/${id}`)
        .set(...eve.auth)
        .send({ title: 'mine' })
        .expect(404);
      await http()
        .post(`/api/v1/events/${id}/pause`)
        .set(...eve.auth)
        .expect(404);
      await http()
        .get(`/api/v1/events/${id}/occurrences`)
        .set(...eve.auth)
        .expect(404);
      await http()
        .delete(`/api/v1/events/${id}`)
        .set(...eve.auth)
        .expect(404);

      const list = await http()
        .get('/api/v1/events')
        .set(...eve.auth)
        .expect(200);
      expect(list.body.items).toEqual([]);

      // Untouched for the owner.
      const own = await http()
        .get(`/api/v1/events/${id}`)
        .set(...auth)
        .expect(200);
      expect(own.body).toMatchObject({ title: BIRTHDAY.title, status: 'ACTIVE' });
    });

    it('rejects a malformed id before it reaches the database', async () => {
      await http()
        .get('/api/v1/events/not-a-uuid')
        .set(...auth)
        .expect(400);
    });
  });

  describe('list', () => {
    it('pages newest-first with a cursor, without gaps or repeats', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push(await createId({ ...BIRTHDAY, title: `Event ${i}` }));

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await http()
          .get('/api/v1/events')
          .query({ limit: 2, ...(cursor && { cursor }) })
          .set(...auth)
          .expect(200);
        seen.push(...res.body.items.map((item: { id: string }) => item.id));
        cursor = res.body.nextCursor;
        pages += 1;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toEqual([...ids].reverse());
    });

    it('filters by status and never lists deleted events', async () => {
      const active = await createId();
      const paused = await createId();
      const deleted = await createId();
      await http()
        .post(`/api/v1/events/${paused}/pause`)
        .set(...auth)
        .expect(200);
      await http()
        .delete(`/api/v1/events/${deleted}`)
        .set(...auth)
        .expect(204);

      const ids = async (query: object = {}) =>
        (
          await http()
            .get('/api/v1/events')
            .query(query)
            .set(...auth)
            .expect(200)
        ).body.items.map((item: { id: string }) => item.id);

      expect(new Set(await ids())).toEqual(new Set([active, paused]));
      expect(await ids({ status: 'PAUSED' })).toEqual([paused]);
      expect(await ids({ status: 'ACTIVE' })).toEqual([active]);
      await http()
        .get('/api/v1/events')
        .query({ status: 'DELETED' })
        .set(...auth)
        .expect(400);
    });

    it('rejects a tampered cursor', async () => {
      await http()
        .get('/api/v1/events')
        .query({ cursor: 'garbage' })
        .set(...auth)
        .expect(400);
    });
  });

  describe('update', () => {
    const versionOf = async (id: string) =>
      (await t.prisma.event.findUniqueOrThrow({ where: { id } })).rruleVersion;

    it('leaves the schedule version alone when only the title changes', async () => {
      const id = await createId();
      const res = await http()
        .patch(`/api/v1/events/${id}`)
        .set(...auth)
        .send({ title: 'Mum’s 70th' })
        .expect(200);
      expect(res.body).toMatchObject({ title: 'Mum’s 70th', rrule: 'FREQ=YEARLY' });
      expect(await versionOf(id)).toBe(1);
    });

    it('bumps the schedule version when the schedule changes', async () => {
      const id = await createId();
      await http()
        .patch(`/api/v1/events/${id}`)
        .set(...auth)
        .send({ startsAtLocal: '2030-06-15T10:00' })
        .expect(200);
      expect(await versionOf(id)).toBe(2);

      await http()
        .patch(`/api/v1/events/${id}`)
        .set(...auth)
        .send({ timezone: 'Europe/Paris' })
        .expect(200);
      expect(await versionOf(id)).toBe(3);
    });

    it('does not bump the version for a no-op schedule edit', async () => {
      const id = await createId();
      await http()
        .patch(`/api/v1/events/${id}`)
        .set(...auth)
        .send({ startsAtLocal: '2030-06-15T09:00:00', rrule: 'FREQ=YEARLY' })
        .expect(200);
      expect(await versionOf(id)).toBe(1);
    });

    it('turns a recurring event into a one-off with rrule: null', async () => {
      const id = await createId();
      const res = await http()
        .patch(`/api/v1/events/${id}`)
        .set(...auth)
        .send({ rrule: null })
        .expect(200);
      expect(res.body.rrule).toBeNull();
      expect(await versionOf(id)).toBe(2);
    });

    it('validates the merged schedule and leaves the event unchanged on failure', async () => {
      const id = await createId();
      await http()
        .patch(`/api/v1/events/${id}`)
        .set(...auth)
        .send({ title: 'changed', rrule: 'FREQ=MINUTELY' })
        .expect(400);

      const row = await t.prisma.event.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ title: BIRTHDAY.title, rrule: 'FREQ=YEARLY', rruleVersion: 1 });
    });

    it('rejects null for fields that cannot be cleared', async () => {
      const id = await createId();
      await http()
        .patch(`/api/v1/events/${id}`)
        .set(...auth)
        .send({ title: null })
        .expect(400);
      await http()
        .patch(`/api/v1/events/${id}`)
        .set(...auth)
        .send({ timezone: null })
        .expect(400);
    });
  });

  describe('pause, resume and delete', () => {
    it('pauses and resumes', async () => {
      const id = await createId();
      const paused = await http()
        .post(`/api/v1/events/${id}/pause`)
        .set(...auth)
        .expect(200);
      expect(paused.body.status).toBe('PAUSED');
      const resumed = await http()
        .post(`/api/v1/events/${id}/resume`)
        .set(...auth)
        .expect(200);
      expect(resumed.body.status).toBe('ACTIVE');
    });

    it('soft-deletes: gone from the API, kept in the database', async () => {
      const id = await createId();
      await http()
        .delete(`/api/v1/events/${id}`)
        .set(...auth)
        .expect(204);

      await http()
        .get(`/api/v1/events/${id}`)
        .set(...auth)
        .expect(404);
      await http()
        .delete(`/api/v1/events/${id}`)
        .set(...auth)
        .expect(404);
      await http()
        .post(`/api/v1/events/${id}/resume`)
        .set(...auth)
        .expect(404);

      const row = await t.prisma.event.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'DELETED', userId });
    });
  });

  describe('occurrences preview', () => {
    it('lists the next occurrences, keeping 9:00 local across DST', async () => {
      const id = await createId({
        ...BIRTHDAY,
        startsAtLocal: '2030-03-29T09:00',
        rrule: 'FREQ=DAILY',
      });

      const res = await http()
        .get(`/api/v1/events/${id}/occurrences`)
        .query({ limit: 3 })
        .set(...auth)
        .expect(200);

      // Berlin springs forward on Sunday 31 March 2030.
      expect(res.body.occurrences).toEqual([
        {
          at: '2030-03-29T08:00:00.000Z',
          localDateTime: '2030-03-29T09:00:00',
          resolution: 'exact',
        },
        {
          at: '2030-03-30T08:00:00.000Z',
          localDateTime: '2030-03-30T09:00:00',
          resolution: 'exact',
        },
        {
          at: '2030-03-31T07:00:00.000Z',
          localDateTime: '2030-03-31T09:00:00',
          resolution: 'exact',
        },
      ]);
    });

    it('lists occurrences in a window, `from` inclusive and `to` exclusive', async () => {
      const id = await createId({
        ...BIRTHDAY,
        timezone: 'UTC',
        startsAtLocal: '2030-01-01T09:00',
        rrule: 'FREQ=WEEKLY',
      });
      const res = await http()
        .get(`/api/v1/events/${id}/occurrences`)
        .query({ from: '2030-01-08T09:00:00Z', to: '2030-01-22T09:00:00Z' })
        .set(...auth)
        .expect(200);
      expect(res.body.occurrences.map((o: { at: string }) => o.at)).toEqual([
        '2030-01-08T09:00:00.000Z',
        '2030-01-15T09:00:00.000Z',
      ]);
    });

    it('shows a one-off event once', async () => {
      const id = await createId({ ...BIRTHDAY, rrule: null });
      const res = await http()
        .get(`/api/v1/events/${id}/occurrences`)
        .set(...auth)
        .expect(200);
      expect(res.body.occurrences).toHaveLength(1);
    });

    it.each([
      ['only `from`', { from: '2030-01-01T00:00:00Z' }],
      ['`to` before `from`', { from: '2030-02-01T00:00:00Z', to: '2030-01-01T00:00:00Z' }],
      ['a window over a year', { from: '2030-01-01T00:00:00Z', to: '2031-06-01T00:00:00Z' }],
      ['a non-ISO date', { from: 'yesterday', to: 'today' }],
      ['a limit over 100', { limit: 1000 }],
    ])('rejects %s', async (_case, query) => {
      const id = await createId();
      await http()
        .get(`/api/v1/events/${id}/occurrences`)
        .query(query)
        .set(...auth)
        .expect(400);
    });
  });
});
