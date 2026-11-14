import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle, seconds } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { auditContextFrom } from '../../../common/audit/audit.service';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import {
  AllowWithoutMfaEnrollment,
  RequireRecentAuth,
} from '../../../common/auth/decorators/account-requirements.decorator';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Env } from '../../../config/env.validation';
import { MfaService, MfaSetup, MfaStatus } from '../application/mfa.service';
import { ReauthService } from '../application/reauth.service';
import { ResendVerificationEmailService } from '../application/resend-verification-email.service';
import { SessionService, SessionSummary } from '../application/session.service';
import { ReauthDto, TotpCodeDto } from './dto/mfa.dto';
import { setAccessCookie } from './session-cookies';

// Signed-in account security: 2FA, step-up, sessions, email verification.
// All usable during a mandatory-2FA lockout — they're how you get out of it.
@Controller('auth')
@AllowWithoutMfaEnrollment()
export class AccountSecurityController {
  constructor(
    private readonly mfa: MfaService,
    private readonly reauth: ReauthService,
    private readonly sessions: SessionService,
    private readonly resendVerification: ResendVerificationEmailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ── Step-up ──────────────────────────────────────────────────────────

  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('reauth')
  @HttpCode(HttpStatus.OK)
  async reauthenticate(
    @Body() dto: ReauthDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ reauthenticatedUntil: Date }> {
    const result = await this.reauth.reauthenticate(
      user.id,
      user.sessionId,
      dto,
      auditContextFrom(req),
    );
    setAccessCookie(
      res,
      result.accessToken,
      result.accessTokenExpiresInSeconds,
      this.secure(),
    );
    return { reauthenticatedUntil: result.reauthenticatedUntil };
  }

  // ── Email verification ───────────────────────────────────────────────

  @Throttle({ default: { limit: 3, ttl: seconds(60) } })
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.OK)
  async resendVerificationEmail(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    await this.resendVerification.resend(user.id);
    return null;
  }

  // ── Sessions ─────────────────────────────────────────────────────────

  @Get('sessions')
  listSessions(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SessionSummary[]> {
    return this.sessions.list(user.id, user.sessionId);
  }

  @Post('sessions/revoke-others')
  @HttpCode(HttpStatus.OK)
  async revokeOtherSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ revoked: number }> {
    return {
      revoked: await this.sessions.revokeOthers(
        user.id,
        user.sessionId,
        auditContextFrom(req),
      ),
    };
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  async revokeSession(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<null> {
    await this.sessions.revoke(user.id, id, auditContextFrom(req));
    return null;
  }

  // ── Two-factor authentication ────────────────────────────────────────

  @Get('mfa')
  status(@CurrentUser() user: AuthenticatedUser): Promise<MfaStatus> {
    return this.mfa.status(user.id);
  }

  // Recent auth required: otherwise a hijacked session could enrol its own
  // authenticator and lock the real owner out.
  @RequireRecentAuth()
  @Post('mfa/totp/setup')
  @HttpCode(HttpStatus.OK)
  startSetup(@CurrentUser() user: AuthenticatedUser): Promise<MfaSetup> {
    return this.mfa.startSetup(user.id);
  }

  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post('mfa/totp/confirm')
  @HttpCode(HttpStatus.OK)
  confirmSetup(
    @Body() dto: TotpCodeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ recoveryCodes: string[] }> {
    return this.mfa.confirmSetup(user.id, dto.code, auditContextFrom(req));
  }

  @RequireRecentAuth()
  @Post('mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  regenerateRecoveryCodes(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ recoveryCodes: string[] }> {
    return this.mfa.regenerateRecoveryCodes(user.id, auditContextFrom(req));
  }

  @RequireRecentAuth()
  @Delete('mfa')
  @HttpCode(HttpStatus.OK)
  async disable(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<null> {
    await this.mfa.disable(user.id, auditContextFrom(req));
    return null;
  }

  private secure(): boolean {
    return this.config.get('NODE_ENV', { infer: true }) === 'production';
  }
}
