import {
  InvalidRecurrenceError,
  MAX_OCCURRENCES_PER_YEAR,
  type Occurrence,
  Recurrence,
  type RecurrenceInput,
} from './index';

// Expected instants below are worked out by hand from each zone's published
// 2026 rules, not produced by the code under test.
//   US:        DST starts Sun 8 Mar 02:00, ends Sun 1 Nov 02:00
//   EU:        DST starts Sun 29 Mar 01:00 UTC, ends Sun 25 Oct 01:00 UTC
//   Sydney:    DST ends Sun 5 Apr 03:00, starts Sun 4 Oct 02:00
//   Lord Howe: 30-minute DST, starts Sun 4 Oct 02:00 → 02:30

const EPOCH = new Date(0);

const parse = (input: RecurrenceInput) => Recurrence.parse(input);
const instants = (occurrences: Occurrence[]) => occurrences.map((o) => o.at.toISOString());
const locals = (occurrences: Occurrence[]) => occurrences.map((o) => o.localDateTime);

function first(input: RecurrenceInput, count: number): Occurrence[] {
  return parse(input).next(EPOCH, count);
}

describe('Recurrence', () => {
  describe('frequencies', () => {
    it('DAILY', () => {
      const daily = first(
        { startsAtLocal: '2026-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=DAILY' },
        3,
      );
      expect(instants(daily)).toEqual([
        '2026-01-01T09:00:00.000Z',
        '2026-01-02T09:00:00.000Z',
        '2026-01-03T09:00:00.000Z',
      ]);
    });

    it('every other Tuesday (FREQ=WEEKLY;BYDAY=TU;INTERVAL=2)', () => {
      const groceries = first(
        {
          startsAtLocal: '2026-01-06T18:00',
          timezone: 'Europe/London',
          rrule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=2',
        },
        3,
      );
      expect(locals(groceries)).toEqual([
        '2026-01-06T18:00:00',
        '2026-01-20T18:00:00',
        '2026-02-03T18:00:00',
      ]);
    });

    it('second Monday of each month (FREQ=MONTHLY;BYDAY=2MO)', () => {
      const meeting = first(
        { startsAtLocal: '2026-01-12T10:00', timezone: 'UTC', rrule: 'FREQ=MONTHLY;BYDAY=2MO' },
        3,
      );
      expect(locals(meeting)).toEqual([
        '2026-01-12T10:00:00',
        '2026-02-09T10:00:00',
        '2026-03-09T10:00:00',
      ]);
    });

    it('YEARLY', () => {
      const anniversary = first(
        { startsAtLocal: '2026-06-15T08:00', timezone: 'UTC', rrule: 'FREQ=YEARLY' },
        2,
      );
      expect(locals(anniversary)).toEqual(['2026-06-15T08:00:00', '2027-06-15T08:00:00']);
    });

    it('accepts an "RRULE:" prefix', () => {
      const rule = parse({
        startsAtLocal: '2026-01-01T09:00',
        timezone: 'UTC',
        rrule: 'RRULE:FREQ=DAILY',
      });
      expect(rule.isRecurring).toBe(true);
    });
  });

  describe('time zones and DST', () => {
    it('keeps a 9:00 Berlin reminder at 9:00 local across spring-forward', () => {
      const daily = first(
        { startsAtLocal: '2026-03-27T09:00', timezone: 'Europe/Berlin', rrule: 'FREQ=DAILY' },
        4,
      );
      expect(instants(daily)).toEqual([
        '2026-03-27T08:00:00.000Z', // CET, UTC+1
        '2026-03-28T08:00:00.000Z',
        '2026-03-29T07:00:00.000Z', // CEST, UTC+2: same wall clock, earlier instant
        '2026-03-30T07:00:00.000Z',
      ]);
      expect(new Set(locals(daily).map((l) => l.slice(11)))).toEqual(new Set(['09:00:00']));
    });

    it('keeps it at 9:00 local across fall-back', () => {
      const daily = first(
        { startsAtLocal: '2026-10-24T09:00', timezone: 'Europe/Berlin', rrule: 'FREQ=DAILY' },
        2,
      );
      expect(instants(daily)).toEqual(['2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z']);
    });

    it('handles the southern hemisphere, where DST runs the other way', () => {
      const autumn = first(
        { startsAtLocal: '2026-04-04T09:00', timezone: 'Australia/Sydney', rrule: 'FREQ=DAILY' },
        2,
      );
      expect(instants(autumn)).toEqual([
        '2026-04-03T22:00:00.000Z', // AEDT, UTC+11
        '2026-04-04T23:00:00.000Z', // AEST, UTC+10
      ]);

      const spring = first(
        { startsAtLocal: '2026-10-03T09:00', timezone: 'Australia/Sydney', rrule: 'FREQ=DAILY' },
        2,
      );
      expect(instants(spring)).toEqual(['2026-10-02T23:00:00.000Z', '2026-10-03T22:00:00.000Z']);
    });

    it('handles a half-hour offset with no DST (Asia/Kolkata, UTC+5:30)', () => {
      const daily = first(
        { startsAtLocal: '2026-06-01T09:00', timezone: 'Asia/Kolkata', rrule: 'FREQ=DAILY' },
        2,
      );
      expect(instants(daily)).toEqual(['2026-06-01T03:30:00.000Z', '2026-06-02T03:30:00.000Z']);
    });

    /**
     * DECISION — a time skipped by spring-forward fires once, shifted forward
     * by the length of the gap (02:30 → 03:30). RFC 5545 §3.3.5 specifies
     * this; the alternative (skipping the day) silently loses a reminder.
     */
    it('fires a reminder inside a spring-forward gap once, shifted forward by the gap', () => {
      const daily = first(
        { startsAtLocal: '2026-03-07T02:30', timezone: 'America/New_York', rrule: 'FREQ=DAILY' },
        3,
      );
      expect(daily).toEqual([
        {
          at: new Date('2026-03-07T07:30:00Z'),
          localDateTime: '2026-03-07T02:30:00',
          resolution: 'exact',
        },
        // 02:30 does not exist on 8 March; fires at 03:30 EDT.
        {
          at: new Date('2026-03-08T07:30:00Z'),
          localDateTime: '2026-03-08T02:30:00',
          resolution: 'shifted-forward',
        },
        {
          at: new Date('2026-03-09T06:30:00Z'),
          localDateTime: '2026-03-09T02:30:00',
          resolution: 'exact',
        },
      ]);
    });

    it('shifts by the actual gap length, not a fixed hour (Lord Howe: 30 minutes)', () => {
      const [occurrence] = parse({
        startsAtLocal: '2026-10-04T02:15',
        timezone: 'Australia/Lord_Howe',
      }).next(EPOCH, 1);
      // 02:15 does not exist; 02:45 at UTC+11 is 15:45 UTC the day before.
      expect(occurrence).toEqual({
        at: new Date('2026-10-03T15:45:00Z'),
        localDateTime: '2026-10-04T02:15:00',
        resolution: 'shifted-forward',
      });
    });

    /**
     * DECISION — a time repeated by fall-back fires once, at the first of the
     * two instants (still on daylight time). Also RFC 5545 §3.3.5. Firing twice
     * would be a duplicate notification, the exact thing this system exists to
     * prevent.
     */
    it('fires a reminder inside a fall-back overlap once, at the earlier instant', () => {
      const daily = first(
        { startsAtLocal: '2026-10-31T01:30', timezone: 'America/New_York', rrule: 'FREQ=DAILY' },
        3,
      );
      expect(daily).toEqual([
        {
          at: new Date('2026-10-31T05:30:00Z'),
          localDateTime: '2026-10-31T01:30:00',
          resolution: 'exact',
        },
        // 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST); only the first.
        {
          at: new Date('2026-11-01T05:30:00Z'),
          localDateTime: '2026-11-01T01:30:00',
          resolution: 'earlier-of-two',
        },
        {
          at: new Date('2026-11-02T06:30:00Z'),
          localDateTime: '2026-11-02T01:30:00',
          resolution: 'exact',
        },
      ]);
    });
  });

  describe('calendar edge cases', () => {
    /**
     * DECISION — BYMONTHDAY=31 skips months without a 31st, as RFC 5545 says
     * ("invalid dates are ignored"). Users who mean "the last day of the month"
     * should be offered BYMONTHDAY=-1 instead.
     */
    it('skips months without a 31st for BYMONTHDAY=31', () => {
      const rent = first(
        { startsAtLocal: '2026-01-31T09:00', timezone: 'UTC', rrule: 'FREQ=MONTHLY;BYMONTHDAY=31' },
        4,
      );
      expect(locals(rent).map((l) => l.slice(0, 10))).toEqual([
        '2026-01-31',
        '2026-03-31',
        '2026-05-31',
        '2026-07-31',
      ]);
    });

    it('uses BYMONTHDAY=-1 for "the last day of every month"', () => {
      const rent = first(
        { startsAtLocal: '2026-01-31T09:00', timezone: 'UTC', rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1' },
        3,
      );
      expect(locals(rent).map((l) => l.slice(0, 10))).toEqual([
        '2026-01-31',
        '2026-02-28',
        '2026-03-31',
      ]);
    });

    /**
     * DECISION — a plain yearly rule starting on Feb 29 occurs only in leap
     * years, per RFC 5545. That is almost never what a person with a leap-day
     * birthday wants, so the event UI (Phase 10) should offer
     * BYMONTH=2;BYMONTHDAY=-1: Feb 29 in leap years, Feb 28 otherwise. The
     * library stays a faithful RRULE implementation; the product choice is
     * made where the rule is written.
     */
    it('fires a Feb 29 yearly rule only in leap years', () => {
      const leapling = first(
        { startsAtLocal: '2024-02-29T09:00', timezone: 'UTC', rrule: 'FREQ=YEARLY' },
        3,
      );
      expect(locals(leapling).map((l) => l.slice(0, 10))).toEqual([
        '2024-02-29',
        '2028-02-29',
        '2032-02-29',
      ]);
    });

    it('fires every year on the last day of February with BYMONTH=2;BYMONTHDAY=-1', () => {
      const leapling = first(
        {
          startsAtLocal: '2024-02-29T09:00',
          timezone: 'UTC',
          rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1',
        },
        5,
      );
      expect(locals(leapling).map((l) => l.slice(0, 10))).toEqual([
        '2024-02-29',
        '2025-02-28',
        '2026-02-28',
        '2027-02-28',
        '2028-02-29',
      ]);
    });

    /**
     * DECISION — the start is the first occurrence only if the rule produces
     * it. RFC 5545 leaves an unsynchronized DTSTART undefined; matching the
     * rule keeps "every Monday" from also firing on the Thursday it was made.
     */
    it('does not treat a start that the rule would not produce as an occurrence', () => {
      const mondays = first(
        { startsAtLocal: '2026-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=WEEKLY;BYDAY=MO' },
        2,
      );
      expect(locals(mondays).map((l) => l.slice(0, 10))).toEqual(['2026-01-05', '2026-01-12']);
    });
  });

  describe('UNTIL and COUNT', () => {
    const berlinDaily = (rrule: string): RecurrenceInput => ({
      startsAtLocal: '2026-06-01T09:00',
      timezone: 'Europe/Berlin',
      rrule,
    });

    it('treats a UTC UNTIL as an instant, inclusive', () => {
      // 09:00 CEST on 3 June is 07:00Z.
      expect(first(berlinDaily('FREQ=DAILY;UNTIL=20260603T070000Z'), 10)).toHaveLength(3);
      // One second earlier excludes it. Comparing UNTIL as wall-clock time (the
      // naive approach) would get both of these wrong by the zone offset.
      expect(first(berlinDaily('FREQ=DAILY;UNTIL=20260603T065959Z'), 10)).toHaveLength(2);
    });

    it('treats a date-only UNTIL as the whole of that local day', () => {
      expect(first(berlinDaily('FREQ=DAILY;UNTIL=20260603'), 10)).toHaveLength(3);
    });

    it('treats an UNTIL without Z as local wall-clock time', () => {
      expect(first(berlinDaily('FREQ=DAILY;UNTIL=20260603T090000'), 10)).toHaveLength(3);
      expect(first(berlinDaily('FREQ=DAILY;UNTIL=20260603T085959'), 10)).toHaveLength(2);
    });

    it('stops after COUNT occurrences', () => {
      const rule = parse(berlinDaily('FREQ=DAILY;COUNT=3'));
      expect(rule.next(EPOCH, 10)).toHaveLength(3);
      expect(rule.between(new Date('2026-01-01Z'), new Date('2027-01-01Z'))).toHaveLength(3);
    });

    it('counts COUNT from the start, not from the query', () => {
      const rule = parse(berlinDaily('FREQ=DAILY;COUNT=3'));
      expect(locals(rule.next(new Date('2026-06-02T12:00:00Z'), 10))).toEqual([
        '2026-06-03T09:00:00',
      ]);
    });
  });

  describe('querying', () => {
    const daily = parse({
      startsAtLocal: '2026-01-01T09:00',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
    });

    it('between() is inclusive of `from` and exclusive of `to`', () => {
      const window = daily.between(
        new Date('2026-01-02T09:00:00Z'),
        new Date('2026-01-04T09:00:00Z'),
      );
      expect(instants(window)).toEqual(['2026-01-02T09:00:00.000Z', '2026-01-03T09:00:00.000Z']);
    });

    it('between() returns nothing before the start', () => {
      expect(daily.between(new Date('2025-01-01Z'), new Date('2026-01-01T08:59:59Z'))).toEqual([]);
    });

    it('next() returns occurrences strictly after the given instant', () => {
      const upcoming = daily.next(new Date('2026-03-10T09:00:00Z'), 2);
      expect(instants(upcoming)).toEqual(['2026-03-11T09:00:00.000Z', '2026-03-12T09:00:00.000Z']);
    });

    it('expands a 30-day horizon for a long-running rule quickly', () => {
      const started = Date.now();
      const horizon = parse({
        startsAtLocal: '1950-01-01T09:00',
        timezone: 'Europe/Berlin',
        rrule: 'FREQ=DAILY',
      }).between(new Date('2026-01-01Z'), new Date('2026-01-31Z'));
      expect(horizon).toHaveLength(30);
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    describe('a one-off event (no RRULE)', () => {
      const once = parse({ startsAtLocal: '2026-05-01T12:00', timezone: 'Europe/Paris' });

      it('occurs exactly once, at its start', () => {
        expect(once.isRecurring).toBe(false);
        expect(instants(once.next(EPOCH, 5))).toEqual(['2026-05-01T10:00:00.000Z']);
        expect(once.next(new Date('2026-05-01T10:00:00Z'), 5)).toEqual([]);
      });

      it('appears in a window only if the window contains it', () => {
        expect(once.between(new Date('2026-05-01Z'), new Date('2026-05-02Z'))).toHaveLength(1);
        expect(once.between(new Date('2026-05-02Z'), new Date('2026-05-03Z'))).toHaveLength(0);
      });
    });
  });

  describe('validation', () => {
    const valid: RecurrenceInput = {
      startsAtLocal: '2026-01-01T09:00',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
    };
    const rejects = (overrides: Partial<RecurrenceInput>, message: RegExp) =>
      expect(() => parse({ ...valid, ...overrides })).toThrow(
        expect.objectContaining({
          name: 'InvalidRecurrenceError',
          message: expect.stringMatching(message),
        }),
      );

    it('throws InvalidRecurrenceError specifically', () => {
      expect(() => parse({ ...valid, rrule: 'FREQ=SECONDLY' })).toThrow(InvalidRecurrenceError);
    });

    it.each(['+01:00', '-0500', 'Mars/Olympus', ''])('rejects time zone %p', (timezone) =>
      rejects({ timezone }, /IANA/),
    );

    it.each([
      ['an impossible date', '2026-02-30T09:00'],
      ['an impossible time', '2026-01-01T25:00'],
      ['an offset', '2026-01-01T09:00+01:00'],
      ['a Z suffix', '2026-01-01T09:00:00Z'],
      ['a date with no time', '2026-01-01'],
    ])('rejects a start with %s', (_case, startsAtLocal) =>
      rejects({ startsAtLocal }, /date-time/),
    );

    it('rejects a start before 1900', () => rejects({ startsAtLocal: '1850-01-01T09:00' }, /1900/));

    it.each(['SECONDLY', 'MINUTELY', 'HOURLY'])('rejects FREQ=%s as abusive volume', (freq) =>
      rejects({ rrule: `FREQ=${freq}` }, /DAILY, WEEKLY, MONTHLY or YEARLY/),
    );

    it('rejects a daily rule that expands past the yearly cap through BYHOUR', () => {
      rejects(
        { rrule: 'FREQ=DAILY;BYHOUR=0,1,2,3,4,5' },
        new RegExp(`${MAX_OCCURRENCES_PER_YEAR}`),
      );
    });

    it('allows four times a day', () => {
      const pills = parse({ ...valid, rrule: 'FREQ=DAILY;BYHOUR=8,12,16,20;BYMINUTE=0' });
      expect(locals(pills.next(EPOCH, 4)).map((l) => l.slice(11, 16))).toEqual([
        '12:00',
        '16:00',
        '20:00',
        '08:00',
      ]);
    });

    it.each([
      ['a rule that can never occur (30 February)', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', /never/],
      ['COUNT=0', 'FREQ=DAILY;COUNT=0', /never/],
      ['an UNTIL before the start', 'FREQ=DAILY;UNTIL=20251231T000000Z', /never/],
      ['a missing FREQ', 'BYDAY=MO', /FREQ/],
      ['an unknown property', 'FREQ=DAILY;FOO=1', /Invalid RRULE/],
      ['INTERVAL=0', 'FREQ=DAILY;INTERVAL=0', /INTERVAL/],
      ['a malformed UNTIL', 'FREQ=DAILY;UNTIL=tomorrow', /UNTIL/],
      ['an impossible UNTIL date', 'FREQ=DAILY;UNTIL=20260230', /UNTIL/],
      ['an embedded DTSTART', 'DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY', /separate fields/],
      ['an embedded TZID', 'FREQ=DAILY;TZID=Europe/Berlin', /separate fields/],
    ])('rejects %s', (_case, rrule, message) => rejects({ rrule }, message));

    it('validates an impossible rule quickly', () => {
      const started = Date.now();
      expect(() => parse({ ...valid, rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30' })).toThrow();
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });
});
