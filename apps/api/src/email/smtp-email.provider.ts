import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { ApiEnv } from '@wanderly/config';
import { createTransport, type Transporter } from 'nodemailer';
import { ENV } from '../config/config.module';
import type { EmailMessage, EmailProvider } from './email-provider';

@Injectable()
export class SmtpEmailProvider implements EmailProvider, OnApplicationShutdown {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(@Inject(ENV) env: ApiEnv) {
    this.transport = createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: false });
    this.from = env.MAIL_FROM;
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}
