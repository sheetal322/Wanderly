import { randomBytes } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import argon2, { type HashOptions } from 'argon2';

// OWASP's recommended Argon2id baseline: 19 MiB memory, 2 iterations, 1 lane.
const ARGON2_OPTIONS: HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class PasswordService implements OnModuleInit {
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    this.dummyHash = await argon2.hash(randomBytes(16).toString('hex'), ARGON2_OPTIONS);
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  verify(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }

  /**
   * Spends the same Argon2 work as a real check, so a login for an unknown email
   * is not measurably faster than one with a wrong password. Always false.
   */
  async verifyAgainstDummy(password: string): Promise<false> {
    await argon2.verify(this.dummyHash, password);
    return false;
  }
}
