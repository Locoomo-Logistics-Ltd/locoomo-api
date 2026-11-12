import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestWithUser } from '../../../common/auth/auth.guard';
import {
  ALLOW_WITHOUT_MFA_ENROLLMENT_KEY,
  REQUIRE_RECENT_AUTH_KEY,
  REQUIRE_VERIFIED_EMAIL_KEY,
} from '../../../common/auth/decorators/account-requirements.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { AccountFlagsService } from '../application/account-flags.service';
import { enrollmentDeadline } from '../application/mfa.service';
import {
  EmailNotVerifiedException,
  MfaEnrollmentRequiredException,
  ReauthRequiredException,
} from '../domain/exceptions/mfa.exceptions';
import { REAUTH_VALID_SECONDS } from '../domain/mfa.constants';

// Global (APP_GUARD, after AuthGuard). Acts only on cookie sessions —
// API-key callers have no user account state. Three independent checks:
//  1. @RequireRecentAuth → session re-authenticated within the last
//     REAUTH_VALID_SECONDS (claim on the access token, no lookup).
//  2. @RequireVerifiedEmail → account email verified.
//  3. Mandatory 2FA (admins): after the grace period, every route except
//     @AllowWithoutMfaEnrollment ones is refused until they enrol.
@Injectable()
export class AccountStateGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly flags: AccountFlagsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    if (!user) {
      return true;
    }
    const targets = [context.getHandler(), context.getClass()];
    const has = (key: string): boolean =>
      this.reflector.getAllAndOverride<boolean>(key, targets) === true;

    if (has(REQUIRE_RECENT_AUTH_KEY)) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (!user.reauthAt || nowSeconds - user.reauthAt > REAUTH_VALID_SECONDS) {
        throw new ReauthRequiredException();
      }
    }

    const needsVerifiedEmail = has(REQUIRE_VERIFIED_EMAIL_KEY);
    const mfaMandatoryRole = user.role === UserRole.ADMIN;
    if (!needsVerifiedEmail && !mfaMandatoryRole) {
      return true;
    }

    const flags = await this.flags.get(user.id);
    if (needsVerifiedEmail && !flags.emailVerified) {
      throw new EmailNotVerifiedException();
    }
    if (
      mfaMandatoryRole &&
      flags.mfaRequiredSince &&
      !flags.mfaEnabled &&
      Date.now() > enrollmentDeadline(flags.mfaRequiredSince).getTime() &&
      !has(ALLOW_WITHOUT_MFA_ENROLLMENT_KEY)
    ) {
      throw new MfaEnrollmentRequiredException();
    }
    return true;
  }
}
