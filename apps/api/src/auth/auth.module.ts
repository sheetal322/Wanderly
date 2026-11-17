import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EmailModule } from '../email/email.module';
import { AccessTokenService } from './access-token.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';

@Module({
  imports: [EmailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    AccessTokenService,
    RefreshTokenService,
    // Global: every route requires a valid access token unless marked @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}
