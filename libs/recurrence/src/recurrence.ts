import { IANAZone } from 'luxon';
import { Frequency, RRule } from 'rrule';
import {
  floatingToWallClock,
  formatWallClock,
  instantToFloating,
  isIanaTimeZone,
  parseLocalDateTime,
  type Resolution,
  resolveWallClock,
  wallClockToFloating,
} from './local-time';

export interface RecurrenceInput {
  /** Wall-clock start, "YYYY-MM-DDTHH:mm[:ss]", no offset. */
  startsAtLocal: string;
  /** IANA zone the wall clock is read in, e.g. "Europe/Berlin". */
  timezone: string;
  /** An RFC 5545 RRULE ("FREQ=WEEKLY;BYDAY=TU"), or null for a one-off event. */
  rrule?: string | null;
}

export interface Occurrence {
  /** The instant to fire at. */
  at: Date;
  /** The wall-clock time the rule produced, in the event's zone. */
  localDateTime: string;
  resolution: Resolution;
}

export class InvalidRecurrenceError extends Error {
  override readonly name = 'InvalidRecurrenceError';
}

/**
 * Sub-daily frequencies are rejected outright: FREQ=SECONDLY would materialize
 * 2.6 million jobs a month per reminder. This is abuse prevention as much as
 * validation, because the database is what a hostile rule attacks.
 */
const ALLOWED_FREQUENCIES = new Set([
  Frequency.YEARLY,
  Frequency.MONTHLY,
  Frequency.WEEKLY,
  Frequency.DAILY,
]);

/**
 * Daily rules can still expand densely through BYHOUR/BYMINUTE. Roughly four
 * a day ("take medication at 8, 12, 16, 20") is the most a personal reminder
 * plausibly needs.
 */
export const MAX_OCCURRENCES_PER_YEAR = 1_500;

const MIN_YEAR = 1900;
const DAY = 24 * 60 * 60 * 1000;
/** Floating and real instants differ by at most ±14h; two days is a safe pad. */
const WINDOW_PAD = 2 * DAY;

/**
 * An event's schedule: a start in local wall-clock time, a zone, and an
 * optional RRULE. Parsing validates everything, so a Recurrence that exists is
 * safe to expand.
 *
 * The algorithm (docs/DESIGN.md §4): expand the rule in local wall-clock time,
 * then convert each result to an instant with the zone's rules on that date.
 * Never recur in UTC: a 9:00 reminder must stay 9:00 across DST.
 */
export class Recurrence {
  private constructor(
    private readonly zone: IANAZone,
    private readonly startFloating: Date,
    private readonly rule: RRule | null,
  ) {}

  static parse(input: RecurrenceInput): Recurrence {
    if (!isIanaTimeZone(input.timezone)) {
      throw new InvalidRecurrenceError(
        `"${input.timezone}" is not an IANA time zone name (e.g. "Europe/Berlin")`,
      );
    }
    const zone = IANAZone.create(input.timezone);

    let startFloating: Date;
    try {
      startFloating = wallClockToFloating(parseLocalDateTime(input.startsAtLocal));
    } catch (error) {
      throw new InvalidRecurrenceError((error as Error).message);
    }
    if (startFloating.getUTCFullYear() < MIN_YEAR) {
      throw new InvalidRecurrenceError(`Start must be in ${MIN_YEAR} or later`);
    }

    const rule = input.rrule ? buildRule(input.rrule, startFloating, zone) : null;
    return new Recurrence(zone, startFloating, rule);
  }

  get isRecurring(): boolean {
    return this.rule !== null;
  }

  /** Occurrences firing in [from, to). */
  between(from: Date, to: Date): Occurrence[] {
    const floating = this.rule
      ? this.rule.between(
          new Date(from.getTime() - WINDOW_PAD),
          new Date(to.getTime() + WINDOW_PAD),
          true,
        )
      : [this.startFloating];

    return floating
      .map((date) => this.resolve(date))
      .filter(({ at }) => at >= from && at < to)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  /** The next `count` occurrences firing strictly after `after`. */
  next(after: Date, count: number): Occurrence[] {
    if (count <= 0) return [];
    if (!this.rule) {
      const only = this.resolve(this.startFloating);
      return only.at > after ? [only] : [];
    }

    const skipBefore = after.getTime() - WINDOW_PAD;
    const found: Occurrence[] = [];
    this.rule.all((date) => {
      if (date.getTime() >= skipBefore) {
        const occurrence = this.resolve(date);
        if (occurrence.at > after) found.push(occurrence);
      }
      return found.length < count;
    });
    return found.slice(0, count);
  }

  private resolve(floating: Date): Occurrence {
    const { at, resolution } = resolveWallClock(floating, this.zone);
    return { at, localDateTime: formatWallClock(floatingToWallClock(floating)), resolution };
  }
}

function buildRule(text: string, startFloating: Date, zone: IANAZone): RRule {
  const body = text.trim().replace(/^RRULE:/i, '');
  if (/[\r\n]/.test(body) || /(^|;)(DTSTART|TZID)\b/i.test(body)) {
    throw new InvalidRecurrenceError(
      'Give only the RRULE: the start time and time zone are separate fields',
    );
  }

  // UNTIL is pulled out and converted by hand: rrule would compare it, as-is,
  // against floating wall-clock dates, which is wrong by the zone's offset.
  const untilMatch = /(^|;)UNTIL=([^;]*)/i.exec(body);
  const withoutUntil = body.replace(/(^|;)UNTIL=[^;]*/i, '').replace(/^;/, '');

  let options: ReturnType<typeof RRule.parseString>;
  try {
    options = RRule.parseString(withoutUntil);
  } catch (error) {
    throw new InvalidRecurrenceError(`Invalid RRULE: ${(error as Error).message}`);
  }

  if (options.freq === undefined) throw new InvalidRecurrenceError('RRULE must include FREQ');
  if (!ALLOWED_FREQUENCIES.has(options.freq)) {
    throw new InvalidRecurrenceError(
      'FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY: more frequent rules are not supported',
    );
  }
  if (options.interval !== undefined && !(options.interval >= 1)) {
    throw new InvalidRecurrenceError('INTERVAL must be a positive integer');
  }

  const rule = new RRule({
    ...options,
    dtstart: startFloating,
    until: untilMatch ? parseUntil(untilMatch[2] ?? '', zone) : null,
    tzid: null,
  });

  if (!rule.after(startFloating, true)) {
    throw new InvalidRecurrenceError('RRULE never produces an occurrence');
  }

  let firstYear = 0;
  rule.between(startFloating, new Date(startFloating.getTime() + 366 * DAY), true, () => {
    firstYear += 1;
    return firstYear <= MAX_OCCURRENCES_PER_YEAR;
  });
  if (firstYear > MAX_OCCURRENCES_PER_YEAR) {
    throw new InvalidRecurrenceError(
      `RRULE produces more than ${MAX_OCCURRENCES_PER_YEAR} occurrences a year`,
    );
  }

  return rule;
}

/**
 * Returns UNTIL as a floating wall-clock date, inclusive.
 * - "20261231T230000Z": an instant (what RFC 5545 requires alongside a TZID
 *   start), converted to the wall clock in the event's zone.
 * - "20261231": a date, taken as the whole of that local day.
 * - "20261231T230000": already wall-clock; accepted for leniency.
 */
function parseUntil(value: string, zone: IANAZone): Date {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i.exec(value);
  if (!match) throw new InvalidRecurrenceError(`Invalid UNTIL "${value}"`);

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const hasTime = match[4] !== undefined;
  const wall = Date.UTC(
    year as number,
    (month as number) - 1,
    day as number,
    hasTime ? (hour as number) : 23,
    hasTime ? (minute as number) : 59,
    hasTime ? (second as number) : 59,
  );
  if (new Date(wall).getUTCDate() !== day)
    throw new InvalidRecurrenceError(`Invalid UNTIL "${value}"`);
  return match[7] ? instantToFloating(new Date(wall), zone) : new Date(wall);
}
