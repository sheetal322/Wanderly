import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsIanaTimeZone } from '../../common/is-iana-timezone';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Field-level checks only. Whether the start, zone and rule make a valid
 * schedule together is decided by @wanderly/recurrence in the service.
 */
export class CreateEventDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  /** Wall-clock time with no offset, e.g. "2026-06-15T09:00". */
  @IsString()
  startsAtLocal!: string;

  /** IANA zone the start is read in, e.g. "Europe/Berlin". */
  @IsIanaTimeZone()
  timezone!: string;

  /** RFC 5545 RRULE, e.g. "FREQ=WEEKLY;BYDAY=TU". Omit or null for a one-off event. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  rrule?: string | null;
}
