import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { ApiEnv } from '@wanderly/config';
import type { Request, Response } from 'express';
import { ENV } from '../config/config.module';
import { AuthService, type Session } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { Public } from './public.decorator';
import { REFRESH_COOKIE, refreshCookieOptions } from './refresh-cookie';

interface AccessTokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

const CHECK_INBOX = { message: 'If the address can receive mail, a message is on its way.' };

@Public()
@Controller('auth')
export class AuthController {
  // Browsers reject Secure cookies over plain http, except on localhost; keep
  // development usable from other hosts (Docker, a phone on the LAN).
  private readonly secureCookies: boolean;

  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) env: ApiEnv,
  ) {
    this.secureCookies = env.NODE_ENV === 'production';
  }

  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  async register(@Body() dto: RegisterDto): Promise<typeof CHECK_INBOX> {
    await this.auth.register(dto);
    return CHECK_INBOX;
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<void> {
    await this.auth.verifyEmail(dto.token);
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  async resendVerification(@Body() dto: ResendVerificationDto): Promise<typeof CHECK_INBOX> {
    await this.auth.resendVerification(dto.email);
    return CHECK_INBOX;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenResponse> {
    return this.respondWithSession(res, await this.auth.login(dto));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenResponse> {
    const presented = this.readRefreshCookie(req);
    if (!presented) throw new UnauthorizedException('Missing refresh token');
    try {
      return this.respondWithSession(res, await this.auth.refresh(presented));
    } catch (error) {
      // A rejected token is dead; stop the browser from presenting it again.
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(this.secureCookies));
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const presented = this.readRefreshCookie(req);
    if (presented) await this.auth.logout(presented);
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(this.secureCookies));
  }

  private readRefreshCookie(req: Request): string | undefined {
    const value: unknown = req.cookies?.[REFRESH_COOKIE];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private respondWithSession(res: Response, session: Session): AccessTokenResponse {
    res.cookie(
      REFRESH_COOKIE,
      session.refreshToken,
      // Never pass `expires` into clearCookie's options: an explicit undefined
      // overrides the epoch date Express uses to delete the cookie.
      { ...refreshCookieOptions(this.secureCookies), expires: session.expiresAt },
    );
    return { accessToken: session.accessToken, tokenType: 'Bearer', expiresIn: session.expiresIn };
  }
}
