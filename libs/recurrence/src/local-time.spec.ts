import { IANAZone } from 'luxon';
import {
  isIanaTimeZone,
  parseLocalDateTime,
  resolveWallClock,
  wallClockToFloating,
} from './local-time';

describe('parseLocalDateTime', () => {
  it('parses with and without seconds', () => {
    expect(parseLocalDateTime('2026-03-08T02:30')).toEqual({
      year: 2026,
      month: 3,
      day: 8,
      hour: 2,
      minute: 30,
      second: 0,
    });
    expect(parseLocalDateTime('2026-03-08T02:30:15').second).toBe(15);
  });

  it('accepts Feb 29 only in a leap year', () => {
    expect(() => parseLocalDateTime('2024-02-29T09:00')).not.toThrow();
    expect(() => parseLocalDateTime('2026-02-29T09:00')).toThrow(/valid calendar/);
  });
});

describe('resolveWallClock', () => {
  const resolve = (local: string, zone: string) =>
    resolveWallClock(wallClockToFloating(parseLocalDateTime(local)), IANAZone.create(zone));

  it('resolves the instants either side of a transition exactly', () => {
    // New York springs forward at 02:00 EST (07:00Z) on 8 March 2026.
    expect(resolve('2026-03-08T01:59:59', 'America/New_York')).toEqual({
      at: new Date('2026-03-08T06:59:59Z'),
      resolution: 'exact',
    });
    expect(resolve('2026-03-08T03:00:00', 'America/New_York')).toEqual({
      at: new Date('2026-03-08T07:00:00Z'),
      resolution: 'exact',
    });
  });

  it('treats the first second of a gap as in the gap', () => {
    expect(resolve('2026-03-08T02:00:00', 'America/New_York')).toEqual({
      at: new Date('2026-03-08T07:00:00Z'),
      resolution: 'shifted-forward',
    });
  });

  it('treats the last second before fall-back as the first of two', () => {
    // 01:59:59 happens at 05:59:59Z (EDT) and again at 06:59:59Z (EST).
    expect(resolve('2026-11-01T01:59:59', 'America/New_York')).toEqual({
      at: new Date('2026-11-01T05:59:59Z'),
      resolution: 'earlier-of-two',
    });
    expect(resolve('2026-11-01T02:00:00', 'America/New_York').resolution).toBe('exact');
  });
});

describe('isIanaTimeZone', () => {
  it.each(['Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Asia/Calcutta', 'UTC'])(
    'accepts %s',
    (zone) => expect(isIanaTimeZone(zone)).toBe(true),
  );

  it.each(['+01:00', '-0500', '−05:00', '0100', 'Mars/Olympus', '', 42, null])(
    'rejects %p',
    (zone) => expect(isIanaTimeZone(zone)).toBe(false),
  );
});
