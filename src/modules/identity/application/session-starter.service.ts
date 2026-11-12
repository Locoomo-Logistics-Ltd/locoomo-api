import { Injectable } from '@nestjs/common';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { MfaService } from './mfa.service';
import {
  IssuedSession,
  SessionClient,
  TokenIssuanceService,
} from './token-issuance.service';

export type LoginResult =
  | { user: UserEntity; session: IssuedSession; mfaToken?: undefined }
  // First factor passed, 2FA pending: no session yet.
  | { user: UserEntity; mfaToken: string; session?: undefined };

// The last step of every sign-in path (password, Google): accounts with 2FA
// get a challenge instead of a session.
@Injectable()
export class SessionStarterService {
  constructor(
    private readonly mfa: MfaService,
    private readonly tokens: TokenIssuanceService,
  ) {}

  // After a successful 2FA challenge: always a session (with step-up).
  async finishAfterMfa(
    user: UserEntity,
    client: SessionClient,
  ): Promise<IssuedSession> {
    return this.tokens.issueSession(user, client, { reauthenticated: true });
  }

  async start(user: UserEntity, client: SessionClient): Promise<LoginResult> {
    const { enabled } = await this.mfa.flags(user.id);
    if (enabled) {
      return { user, mfaToken: await this.mfa.createChallenge(user.id) };
    }
    // A sign-in that just proved the password (or Google) counts as a fresh
    // re-authentication for the next few minutes.
    return {
      user,
      session: await this.tokens.issueSession(user, client, {
        reauthenticated: true,
      }),
    };
  }
}
