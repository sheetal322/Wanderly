import { ValidateBy, type ValidationOptions } from 'class-validator';

/**
 * An IANA zone name ("Europe/Berlin"), never a fixed offset ("+01:00").
 *
 * class-validator's @IsTimeZone() asks Intl, and recent ICU accepts offset
 * strings as time zones. An offset is a fact about one moment; a zone is a rule
 * that changes with DST. Recurrence needs the rule.
 */
export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || /^[+\-−\d]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function IsIanaTimeZone(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isIanaTimeZone',
      validator: {
        validate: isIanaTimeZone,
        defaultMessage: () => '$property must be an IANA time zone name, e.g. "Europe/Berlin"',
      },
    },
    options,
  );
}
