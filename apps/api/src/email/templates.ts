import type { EmailMessage } from './email-provider';

export function verificationEmail(to: string, link: string, ttlHours: number): EmailMessage {
  return {
    to,
    subject: 'Verify your Wanderly email address',
    text: [
      'Welcome to Wanderly.',
      '',
      `Confirm this email address by opening the link below. It expires in ${ttlHours} hours.`,
      '',
      link,
      '',
      'If you did not create a Wanderly account, you can ignore this email.',
    ].join('\n'),
  };
}

/**
 * Sent instead of an error when someone registers an address that already has
 * a verified account, so the registration response never reveals which emails
 * are taken.
 */
export function alreadyRegisteredEmail(to: string, appUrl: string): EmailMessage {
  return {
    to,
    subject: 'You already have a Wanderly account',
    text: [
      'Someone, hopefully you, tried to create a Wanderly account with this email address.',
      '',
      `You already have one. Log in at ${appUrl}`,
      '',
      'If this was not you, no action is needed. Your account has not changed.',
    ].join('\n'),
  };
}
