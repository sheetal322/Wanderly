export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Every email goes through this interface, so the SMTP transport used locally
 * (Mailpit) can be swapped for a hosted provider without touching callers.
 */
export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
