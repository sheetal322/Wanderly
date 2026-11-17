import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { ApiEnv } from '@wanderly/config';
import { Prisma, type User } from '@wanderly/db';
import { ENV } from '../config/config.module';
import { EMAIL_PROVIDER, type EmailMessage, type EmailProvider } from '../email/email-provider';
import { alreadyRegisteredEmail, verificationEmail } from '../email/templates';
import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenService, type IssuedAccessToken } from './access-token.service';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { generateOpaqueToken, hashOpaqueToken } from './opaque-token';
import { PasswordService } from './password.service';
import { type IssuedRefreshToken, RefreshTokenService } from './refresh-token.service';

export type Session = IssuedAccessToken & IssuedRefreshToken;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokens: RefreshTokenService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * Responds identically whether or not the email is taken; the difference is
   * only in what lands in that inbox. Prevents enumerating accounts.
   */
  async register(dto: RegisterDto): Promise<void> {
    // Hashed up front so both branches cost the same Argon2 work.
    const passwordHash = await this.passwords.hash(dto.password);
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });

    if (existing?.emailVerifiedAt) {
      await this.sendSafely(alreadyRegisteredEmail(existing.email, this.env.APP_URL));
      return;
    }

    if (existing) {
      // Re-registering an unverified address takes it over, and sendVerification
      // invalidates every earlier link. Whoever verifies therefore always
      // verifies the password from the latest registration, so someone who
      // pre-registers a victim's address cannot keep a password on it.
      const user = await this.prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash, defaultTimezone: dto.timezone },
      });
      await this.sendVerification(user);
      return;
    }

    let user: User;
    try {
      user = await this.prisma.user.create({
        data: { email: dto.email, passwordHash, defaultTimezone: dto.timezone },
      });
    } catch (error) {
      // A concurrent registration for the same address won the unique index.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }
    await this.sendVerification(user);
  }

  async verifyEmail(token: string): Promise<void> {
    const now = new Date();
    const verified = await this.prisma.$transaction(async (tx) => {
      // Consuming via a conditional UPDATE makes each link single-use even
      // under concurrent clicks.
      const consumed = await tx.emailVerificationToken.updateManyAndReturn({
        where: { tokenHash: hashOpaqueToken(token), consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
        select: { userId: true },
      });
      const [row] = consumed;
      if (!row) return false;

      await tx.user.updateMany({
        where: { id: row.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      return true;
    });

    if (!verified) throw new BadRequestException('Invalid or expired verification token');
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt) await this.sendVerification(user);
  }

  async login(dto: LoginDto): Promise<Session> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    const passwordOk = user
      ? await this.passwords.verify(user.passwordHash, dto.password)
      : await this.passwords.verifyAgainstDummy(dto.password);

    // One message for both cases: the response must not reveal which emails exist.
    if (!user || !passwordOk) throw new UnauthorizedException('Invalid email or password');

    // Checked only after the password, so this 403 reveals nothing to someone
    // who does not already know the password.
    if (!user.emailVerifiedAt) throw new ForbiddenException('Email address has not been verified');

    return this.startSession(user.id);
  }

  async refresh(presented: string): Promise<Session> {
    const { userId, ...refresh } = await this.refreshTokens.rotate(presented);
    return { ...this.accessTokens.sign(userId), ...refresh };
  }

  async logout(presented: string): Promise<void> {
    await this.refreshTokens.revokeFamilyOf(presented);
  }

  private async startSession(userId: string): Promise<Session> {
    const refresh = await this.refreshTokens.issue(userId);
    return { ...this.accessTokens.sign(userId), ...refresh };
  }

  /** Only the newest link works: earlier unconsumed tokens are deleted. */
  private async sendVerification(user: User): Promise<void> {
    const token = generateOpaqueToken();
    const ttlHours = this.env.EMAIL_VERIFICATION_TTL_HOURS;

    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.deleteMany({
        where: { userId: user.id, consumedAt: null },
      }),
      this.prisma.emailVerificationToken.create({
        data: {
          userId: user.id,
          tokenHash: hashOpaqueToken(token),
          expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
        },
      }),
    ]);

    const link = new URL('/verify-email', this.env.APP_URL);
    link.searchParams.set('token', token);
    await this.sendSafely(verificationEmail(user.email, link.toString(), ttlHours));
  }

  /**
   * A failed send must not fail the request: the account state is already
   * committed and the user can ask for a resend. Phase 7 replaces this with the
   * outbox, which retries instead of logging and moving on.
   */
  private async sendSafely(message: EmailMessage): Promise<void> {
    try {
      await this.email.send(message);
    } catch (error) {
      this.logger.error({ err: error, subject: message.subject }, 'Failed to send email');
    }
  }
}
