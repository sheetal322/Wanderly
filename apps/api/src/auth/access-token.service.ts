import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { ApiEnv } from '@wanderly/config';
import jwt from 'jsonwebtoken';
import { ENV } from '../config/config.module';

const ISSUER = 'wanderly';
const AUDIENCE = 'wanderly-api';

export interface AuthenticatedUser {
  userId: string;
}

export interface IssuedAccessToken {
  accessToken: string;
  expiresIn: number;
}

/**
 * RS256 access JWTs: the API signs with the private key; anything holding only
 * the public key can verify but never mint.
 */
@Injectable()
export class AccessTokenService {
  constructor(@Inject(ENV) private readonly env: ApiEnv) {}

  sign(userId: string): IssuedAccessToken {
    const accessToken = jwt.sign({}, this.env.JWT_PRIVATE_KEY, {
      algorithm: 'RS256',
      subject: userId,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS,
    });
    return { accessToken, expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS };
  }

  verify(token: string): AuthenticatedUser {
    try {
      const payload = jwt.verify(token, this.env.JWT_PUBLIC_KEY, {
        // Pinned: never let the token's own header choose the algorithm
        // (the classic "alg: none" / HS256-with-public-key confusion attacks).
        algorithms: ['RS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (typeof payload === 'string' || !payload.sub) {
        throw new Error('Token has no subject');
      }
      return { userId: payload.sub };
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
