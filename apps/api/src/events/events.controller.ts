import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Event } from '@wanderly/db';
import type { Occurrence } from '@wanderly/recurrence';
import type { AuthenticatedUser } from '../auth/access-token.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateEventDto } from './dto/create-event.dto';
import { ListEventsQuery } from './dto/list-events.query';
import { OccurrencesQuery } from './dto/occurrences.query';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventsService, fromFloatingDate } from './events.service';

interface EventResponse {
  id: string;
  title: string;
  description: string | null;
  startsAtLocal: string;
  timezone: string;
  rrule: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

const toResponse = (event: Event): EventResponse => ({
  id: event.id,
  title: event.title,
  description: event.description,
  startsAtLocal: fromFloatingDate(event.startsAtLocal),
  timezone: event.timezone,
  rrule: event.rrule,
  status: event.status,
  createdAt: event.createdAt,
  updatedAt: event.updatedAt,
});

const EventId = () => Param('id', new ParseUUIDPipe({ version: '4' }));

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  async create(
    @CurrentUser() { userId }: AuthenticatedUser,
    @Body() dto: CreateEventDto,
  ): Promise<EventResponse> {
    return toResponse(await this.events.create(userId, dto));
  }

  @Get()
  async list(
    @CurrentUser() { userId }: AuthenticatedUser,
    @Query() query: ListEventsQuery,
  ): Promise<{ items: EventResponse[]; nextCursor: string | null }> {
    const page = await this.events.list(userId, query);
    return { items: page.items.map(toResponse), nextCursor: page.nextCursor };
  }

  @Get(':id')
  async get(
    @CurrentUser() { userId }: AuthenticatedUser,
    @EventId() id: string,
  ): Promise<EventResponse> {
    return toResponse(await this.events.get(userId, id));
  }

  @Patch(':id')
  async update(
    @CurrentUser() { userId }: AuthenticatedUser,
    @EventId() id: string,
    @Body() dto: UpdateEventDto,
  ): Promise<EventResponse> {
    return toResponse(await this.events.update(userId, id, dto));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() { userId }: AuthenticatedUser, @EventId() id: string): Promise<void> {
    await this.events.remove(userId, id);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  async pause(
    @CurrentUser() { userId }: AuthenticatedUser,
    @EventId() id: string,
  ): Promise<EventResponse> {
    return toResponse(await this.events.setStatus(userId, id, 'PAUSED'));
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  async resume(
    @CurrentUser() { userId }: AuthenticatedUser,
    @EventId() id: string,
  ): Promise<EventResponse> {
    return toResponse(await this.events.setStatus(userId, id, 'ACTIVE'));
  }

  /** A preview with no side effects: the same expansion the scheduler will use. */
  @Get(':id/occurrences')
  async occurrences(
    @CurrentUser() { userId }: AuthenticatedUser,
    @EventId() id: string,
    @Query() query: OccurrencesQuery,
  ): Promise<{ occurrences: Occurrence[] }> {
    return { occurrences: await this.events.occurrences(userId, id, query) };
  }
}
