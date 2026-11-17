import { Module } from '@nestjs/common';
import { EMAIL_PROVIDER } from './email-provider';
import { SmtpEmailProvider } from './smtp-email.provider';

/**
 * Sends directly from the API for now. Phase 7 moves email onto the outbox →
 * Kafka → worker pipeline, behind the same EmailProvider interface.
 */
@Module({
  providers: [{ provide: EMAIL_PROVIDER, useClass: SmtpEmailProvider }],
  exports: [EMAIL_PROVIDER],
})
export class EmailModule {}
