import { isIanaTimeZone } from './is-iana-timezone';

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
