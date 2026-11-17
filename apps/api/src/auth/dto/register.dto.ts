import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { IsIanaTimeZone } from '../../common/is-iana-timezone';
import { normalizeEmail } from './normalize-email';

export class RegisterDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // Length is the property that matters; composition rules mostly produce
  // "Password1!". The upper bound caps the work an attacker can make Argon2 do.
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;

  /** IANA identifier, e.g. "Europe/Berlin". Never a fixed offset. */
  @IsIanaTimeZone()
  timezone!: string;
}
