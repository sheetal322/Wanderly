import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { IsIanaTimeZone } from '../../common/is-iana-timezone';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Absent means "unchanged"; null is not a valid value for these fields. */
const present = (_: object, value: unknown) => value !== undefined;

/** Every field optional. `description` and `rrule` accept null to clear them. */
export class UpdateEventDto {
  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ValidateIf(present)
  @IsString()
  startsAtLocal?: string;

  @ValidateIf(present)
  @IsIanaTimeZone()
  timezone?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  rrule?: string | null;
}
