import { Controller, Get, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/access-token.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

interface MeResponse {
  id: string;
  email: string;
  timezone: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

@Controller('me')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async me(@CurrentUser() { userId }: AuthenticatedUser): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    // A valid token for a deleted account: the token outlived the user.
    if (!user) throw new UnauthorizedException();
    return {
      id: user.id,
      email: user.email,
      timezone: user.defaultTimezone,
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt,
    };
  }
}
