import { isIanaTimeZone } from '@wanderly/recurrence';
import { ValidateBy, type ValidationOptions } from 'class-validator';

/**
 * An IANA zone name ("Europe/Berlin"), never a fixed offset ("+01:00").
 * class-validator's own @IsTimeZone() accepts offsets; the rule lives in
 * @wanderly/recurrence so the API and the recurrence engine cannot disagree.
 */
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
