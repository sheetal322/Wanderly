import { IANAZone } from 'luxon';

/**
 * A wall-clock reading with no time zone: the user's intent ("9am on the 3rd"),
 * not an instant. Recurrence is computed entirely in these.
 */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * How a wall-clock time became an instant. Only the two DST transitions make
 * this anything other than "exact"; both follow RFC 5545 §3.3.5.
 */
export type Resolution =
  /** The wall-clock time exists exactly once. */
  | 'exact'
  /** Spring-forward skipped it: moved forward by the gap (02:30 → 03:30). */
  | 'shifted-forward'
  /** Fall-back repeated it: the first of the two occurrences, fired once. */
  | 'earlier-of-two';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parses "YYYY-MM-DDTHH:mm[:ss]". Anything carrying an offset or "Z" is
 * rejected: that would be an instant, and the zone is a separate field.
 */
export function parseLocalDateTime(value: string): WallClock {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) {
    throw new Error(
      `"${value}" is not a local date-time (expected YYYY-MM-DDTHH:mm[:ss], no offset)`,
    );
  }
  const [year, month, day, hour, minute, second = 0] = match
    .slice(1)
    .map((part) => Number(part ?? 0));
  const wall = { year, month, day, hour, minute, second } as WallClock;

  // Round-trip through the calendar to reject Feb 30, 25:00 and friends.
  if (formatWallClock(floatingToWallClock(wallClockToFloating(wall))) !== formatWallClock(wall)) {
    throw new Error(`"${value}" is not a valid calendar date-time`);
  }
  return wall;
}

export function formatWallClock(wall: WallClock): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
}

/**
 * The "floating" representation the rrule library works in: a Date whose UTC
 * fields hold the wall-clock fields. It is not an instant, and must never be
 * compared with one.
 */
export function wallClockToFloating(wall: WallClock): Date {
  return new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second),
  );
}

export function floatingToWallClock(floating: Date): WallClock {
  return {
    year: floating.getUTCFullYear(),
    month: floating.getUTCMonth() + 1,
    day: floating.getUTCDate(),
    hour: floating.getUTCHours(),
    minute: floating.getUTCMinutes(),
    second: floating.getUTCSeconds(),
  };
}

/** The wall clock in `zone` at a real instant, as a floating Date. */
export function instantToFloating(instant: Date, zone: IANAZone): Date {
  return new Date(instant.getTime() + zone.offset(instant.getTime()) * MINUTE);
}

/**
 * Converts a wall-clock time in `zone` to the instant it denotes, using the
 * zone's rules on that specific date.
 *
 * A wall-clock time can map to one instant, none (inside a spring-forward gap)
 * or two (inside a fall-back overlap). The candidates are the offsets in force
 * just before and just after the date; a candidate is real only if the zone
 * agrees that it has that offset at the resulting instant.
 */
export function resolveWallClock(
  floating: Date,
  zone: IANAZone,
): { at: Date; resolution: Resolution } {
  const wall = floating.getTime();
  // A day either side: no zone has ever changed offset twice within two days.
  const offsetBefore = zone.offset(wall - DAY);
  const offsetAfter = zone.offset(wall + DAY);

  const candidates = [...new Set([offsetBefore, offsetAfter])]
    .map((offset) => ({ offset, instant: wall - offset * MINUTE }))
    .filter(({ offset, instant }) => zone.offset(instant) === offset)
    .map(({ instant }) => instant)
    .sort((a, b) => a - b);

  const [first] = candidates;
  if (first === undefined) {
    // In the gap. RFC 5545: interpret with the offset from before the gap,
    // which lands the same distance past the transition as the gap is long.
    return { at: new Date(wall - offsetBefore * MINUTE), resolution: 'shifted-forward' };
  }
  return { at: new Date(first), resolution: candidates.length > 1 ? 'earlier-of-two' : 'exact' };
}

/**
 * An IANA zone name ("Europe/Berlin"), never a fixed offset ("+01:00"). Both
 * luxon and Intl accept offset strings as zones; an offset is a fact about one
 * moment, a zone is a rule that changes with DST, and recurrence needs the rule.
 */
export function isIanaTimeZone(value: unknown): value is string {
  return typeof value === 'string' && !/^[+\-−\d]/.test(value) && IANAZone.isValidZone(value);
}
