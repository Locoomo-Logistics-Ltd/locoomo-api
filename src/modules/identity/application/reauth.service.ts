import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AuditRequestContext,
  AuditService,
} from '../../../common/audit/audit.service';
import { EntityNotFoundException } from '../../../common/exceptions';
import { InvalidCredentialsException } from '../domain/exceptions/invalid-credentials.exception';
import { InvalidMfaCodeException } from '../domain/exceptions/mfa.exceptions';
import { REAUTH_VALID_SECONDS } from '../domain/mfa.constants';
import { verifyPassword } from '../domain/password-hasher';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { GoogleIdTokenVerifier } from '../infrastructure/google-id-token-verifier';
import { MfaService } from './mfa.service';
import { TokenIssuanceService } from './token-issuance.service';

export interface ReauthInput {
  password?: string;
  code?: string;
  recoveryCode?: string;
  googleIdToken?: string;
}

export interface ReauthResult {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  reauthenticatedUntil: Date;
}

// Step-up: prove it's really the account holder before a sensitive action
// (live API keys, webhook URL, bank account, roles, closing the account).
// The strongest factor the account has is required — with 2FA on, a
// password alone is not enough (a stolen session + phished password would
// otherwise defeat 2FA).
@Injectable()
export class ReauthService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly mfa: MfaService,
    private readonly googleVerifier: GoogleIdTokenVerifier,
    private readonly tokens: TokenIssuanceService,
    private readonly audit: AuditService,
  ) {}

  async reauthenticate(
    userId: string,
    sessionId: string | undefined,
    input: ReauthInput,
    context: AuditRequestContext,
  ): Promise<ReauthResult> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) {
      throw new EntityNotFoundException('User', userId);
    }

    const { enabled: mfaEnabled } = await this.mfa.flags(userId);
    if (mfaEnabled) {
      if (input.code !== undefined) {
        await this.mfa.verifySecondFactor(userId, { code: input.code });
      } else if (input.recoveryCode !== undefined) {
        await this.mfa.verifySecondFactor(userId, {
          recoveryCode: input.recoveryCode,
        });
      } else {
        throw new InvalidMfaCodeException();
      }
    } else if (user.passwordHash) {
      if (
        input.password === undefined ||
        !(await verifyPassword(input.password, user.passwordHash))
      ) {
        throw new InvalidCredentialsException();
      }
    } else {
      // Google-only account without 2FA: a fresh Google sign-in for the
      // same Google account.
      const identity = input.googleIdToken
        ? await this.googleVerifier.verify(input.googleIdToken)
        : null;
      if (!identity || identity.sub !== user.googleId) {
        throw new InvalidCredentialsException();
      }
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const accessToken = await this.tokens.issueAccessToken(
      user,
      sessionId,
      nowSeconds,
    );
    await this.audit.record({
      actor: { type: 'user', id: userId, role: user.role },
      action: 'auth.reauthenticated',
      target: { type: 'user', id: userId },
      context,
    });
    return {
      accessToken,
      accessTokenExpiresInSeconds: 15 * 60,
      reauthenticatedUntil: new Date(
        (nowSeconds + REAUTH_VALID_SECONDS) * 1000,
      ),
    };
  }
}
