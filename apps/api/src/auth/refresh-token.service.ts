import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { ApiEnv } from '@wanderly/config';
import type { Prisma } from '@wanderly/db';
import { ENV } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { generateOpaqueToken, hashOpaqueToken } from './opaque-token';

export interface IssuedRefreshToken {
  refreshToken: string;
  expiresAt: Date;
}

const INVALID = 'Invalid or expired refresh token';

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  /** Starts a new family on login, or continues one on rotation. */
  async issue(
    userId: string,
    familyId: string = randomUUID(),
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<IssuedRefreshToken> {
    const refreshToken = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await db.refreshToken.create({
      data: { userId, familyId, tokenHash: hashOpaqueToken(refreshToken), expiresAt },
    });
    return { refreshToken, expiresAt };
  }

  /**
   * Exchanges a refresh token for a new one in the same family. A token that
   * was already used means a copy exists somewhere else, so the whole family is
   * revoked and every holder (legitimate or not) must log in again.
   */
  async rotate(presented: string): Promise<{ userId: string } & IssuedRefreshToken> {
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashOpaqueToken(presented) },
    });
    if (!existing) throw new UnauthorizedException(INVALID);

    if (existing.revokedAt) {
      await this.revokeForReuse(existing.familyId, existing.userId);
      throw new UnauthorizedException(INVALID);
    }
    if (existing.expiresAt <= new Date()) throw new UnauthorizedException(INVALID);

    const rotated = await this.prisma.$transaction(async (tx) => {
      // The claim is a conditional UPDATE, not the read above: two concurrent
      // requests with the same token serialize on the row lock, and only the
      // first sees revoked_at IS NULL. The second claims nothing.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count === 0) return null;
      return this.issue(existing.userId, existing.familyId, tx);
    });

    if (!rotated) {
      // Lost the race to another request presenting the same token: that is
      // reuse by definition, even if both requests came from the same browser.
      await this.revokeForReuse(existing.familyId, existing.userId);
      throw new UnauthorizedException(INVALID);
    }

    return { userId: existing.userId, ...rotated };
  }

  /** Logout: ends this session (the family), leaving other devices signed in. */
  async revokeFamilyOf(presented: string): Promise<void> {
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashOpaqueToken(presented) },
      select: { familyId: true },
    });
    if (existing) await this.revokeFamily(existing.familyId);
  }

  private async revokeForReuse(familyId: string, userId: string): Promise<void> {
    this.logger.warn({ userId, familyId }, 'Refresh token reuse detected; revoking token family');
    await this.revokeFamily(familyId);
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
