import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { type Event, EventStatus, Prisma } from '@wanderly/db';
import {
  InvalidRecurrenceError,
  type Occurrence,
  Recurrence,
  type RecurrenceInput,
} from '@wanderly/recurrence';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateEventDto } from './dto/create-event.dto';
import type { ListEventsQuery } from './dto/list-events.query';
import type { OccurrencesQuery } from './dto/occurrences.query';
import type { UpdateEventDto } from './dto/update-event.dto';

export interface EventPage {
  items: Event[];
  nextCursor: string | null;
}

const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every query here is scoped by userId in the WHERE clause itself, never
 * "load by id, then check the owner": a forgotten check would be an IDOR, a
 * forgotten argument is a compile error. Another user's event is a 404, not a
 * 403, so ids cannot be probed for existence.
 */
@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateEventDto): Promise<Event> {
    const schedule = validateSchedule({
      startsAtLocal: dto.startsAtLocal,
      timezone: dto.timezone,
      rrule: normalizeRrule(dto.rrule),
    });
    return this.prisma.event.create({
      data: {
        userId,
        title: dto.title,
        description: dto.description ?? null,
        startsAtLocal: toFloatingDate(schedule.startsAtLocal),
        timezone: schedule.timezone,
        rrule: schedule.rrule ?? null,
      },
    });
  }

  async list(userId: string, query: ListEventsQuery): Promise<EventPage> {
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.prisma.event.findMany({
      where: {
        userId,
        status: query.status ?? { in: [EventStatus.ACTIVE, EventStatus.PAUSED] },
        // Keyset pagination: stable under concurrent inserts, and an index
        // seek rather than OFFSET's walk-and-discard.
        ...(after && {
          OR: [
            { createdAt: { lt: after.createdAt } },
            { createdAt: after.createdAt, id: { lt: after.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null };
  }

  async get(userId: string, id: string): Promise<Event> {
    const event = await this.prisma.event.findFirst({ where: liveEvent(userId, id) });
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }

  async update(userId: string, id: string, dto: UpdateEventDto): Promise<Event> {
    const existing = await this.get(userId, id);
    const before: RecurrenceInput = {
      startsAtLocal: fromFloatingDate(existing.startsAtLocal),
      timezone: existing.timezone,
      rrule: existing.rrule,
    };
    const after = validateSchedule({
      startsAtLocal: dto.startsAtLocal ?? before.startsAtLocal,
      timezone: dto.timezone ?? before.timezone,
      rrule: dto.rrule === undefined ? before.rrule : normalizeRrule(dto.rrule),
    });

    const scheduleChanged =
      after.timezone !== before.timezone ||
      (after.rrule ?? null) !== (before.rrule ?? null) ||
      toFloatingDate(after.startsAtLocal).getTime() !== existing.startsAtLocal.getTime();

    return this.updateLive(userId, id, {
      title: dto.title,
      description: dto.description,
      startsAtLocal: toFloatingDate(after.startsAtLocal),
      timezone: after.timezone,
      rrule: after.rrule ?? null,
      ...(scheduleChanged && { rruleVersion: { increment: 1 } }),
    });
  }

  setStatus(userId: string, id: string, status: 'ACTIVE' | 'PAUSED'): Promise<Event> {
    return this.updateLive(userId, id, { status });
  }

  /** Soft delete: the row stays for history, but the event is gone from the API. */
  async remove(userId: string, id: string): Promise<void> {
    await this.updateLive(userId, id, { status: EventStatus.DELETED });
  }

  async occurrences(userId: string, id: string, query: OccurrencesQuery): Promise<Occurrence[]> {
    const event = await this.get(userId, id);
    const recurrence = Recurrence.parse({
      startsAtLocal: fromFloatingDate(event.startsAtLocal),
      timezone: event.timezone,
      rrule: event.rrule,
    });

    if (query.from === undefined && query.to === undefined) {
      return recurrence.next(new Date(), query.limit);
    }
    if (query.from === undefined || query.to === undefined) {
      throw new BadRequestException(['from and to must be given together']);
    }
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (to <= from) throw new BadRequestException(['to must be after from']);
    if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
      throw new BadRequestException(['The window can be at most 366 days']);
    }
    return recurrence.between(from, to).slice(0, query.limit);
  }

  private async updateLive(
    userId: string,
    id: string,
    data: Prisma.EventUpdateInput,
  ): Promise<Event> {
    try {
      return await this.prisma.event.update({ where: liveEvent(userId, id), data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Event not found');
      }
      throw error;
    }
  }
}

function liveEvent(userId: string, id: string) {
  return { id, userId, status: { not: EventStatus.DELETED } };
}

/** Checks the start, zone and rule together, as one schedule. */
function validateSchedule(input: RecurrenceInput): RecurrenceInput {
  try {
    Recurrence.parse(input);
    return input;
  } catch (error) {
    if (error instanceof InvalidRecurrenceError) throw new BadRequestException([error.message]);
    throw error;
  }
}

function normalizeRrule(rrule: string | null | undefined): string | null {
  const body = rrule?.trim().replace(/^RRULE:/i, '');
  return body ? body : null;
}

/**
 * starts_at_local is a timestamp without time zone. Prisma reads and writes
 * those through a Date's UTC fields, so the wall clock travels in them as-is.
 */
function toFloatingDate(local: string): Date {
  return new Date(`${local.length === 16 ? `${local}:00` : local}Z`);
}

export function fromFloatingDate(date: Date): string {
  return date.toISOString().slice(0, 19);
}

function encodeCursor(event: Event): string {
  return Buffer.from(JSON.stringify([event.createdAt.toISOString(), event.id])).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [createdAt, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as unknown[];
    const date = new Date(String(createdAt));
    if (typeof id !== 'string' || !UUID.test(id) || Number.isNaN(date.getTime())) throw new Error();
    return { createdAt: date, id };
  } catch {
    throw new BadRequestException(['Invalid cursor']);
  }
}
