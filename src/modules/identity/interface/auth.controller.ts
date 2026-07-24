import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle, seconds } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Env } from '../../../config/env.validation';
import { InvalidRefreshTokenException } from '../domain/exceptions/invalid-refresh-token.exception';
import { ConfirmInviteService } from '../application/confirm-invite.service';
import { ConfirmPasswordResetService } from '../application/confirm-password-reset.service';
import { LoginUserService } from '../application/login-user.service';
import { LogoutUserService } from '../application/logout-user.service';
import { RefreshSessionService } from '../application/refresh-session.service';
import { RegisterUserService } from '../application/register-user.service';
import { RequestPasswordResetService } from '../application/request-password-reset.service';
import { VerifyEmailService } from '../application/verify-email.service';
import { Public } from './decorators/public.decorator';
import { ConfirmEmailVerificationDto } from './dto/confirm-email-verification.dto';
import { ConfirmInviteDto } from './dto/confirm-invite.dto';
import { ConfirmPasswordResetDto } from './dto/confirm-password-reset.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { UserResponseDto } from './dto/user-response.dto';
import {
  clearSessionCookies,
  REFRESH_TOKEN_COOKIE,
  setSessionCookies,
} from './session-cookies';

// Every route here must work without an existing valid session
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerUserService: RegisterUserService,
    private readonly loginUserService: LoginUserService,
    private readonly refreshSessionService: RefreshSessionService,
    private readonly logoutUserService: LogoutUserService,
    private readonly requestPasswordResetService: RequestPasswordResetService,
    private readonly confirmPasswordResetService: ConfirmPasswordResetService,
    private readonly verifyEmailService: VerifyEmailService,
    private readonly confirmInviteService: ConfirmInviteService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  // Stricter than the app-wide default (100/min) — these two are the
  // classic brute-force/enumeration targets. Per-IP, so it's a first line
  // of defense that catches a distributed attack too.
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto): Promise<UserResponseDto> {
    return this.registerUserService.register(dto);
  }

  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserResponseDto> {
    const { user, session } = await this.loginUserService.login(dto);

    setSessionCookies(res, session, this.useSecureCookies());

    return UserResponseDto.fromEntity(user);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserResponseDto> {
    const rawToken = (req.cookies as Record<string, string> | undefined)?.[
      REFRESH_TOKEN_COOKIE
    ];

    if (!rawToken) {
      throw new InvalidRefreshTokenException();
    }

    try {
      const { user, session } =
        await this.refreshSessionService.refresh(rawToken);
      setSessionCookies(res, session, this.useSecureCookies());
      return UserResponseDto.fromEntity(user);
    } catch (error) {
      // Any failure (invalid/expired/reused token, suspended account) means
      // the client is holding a session that will never work again — clear
      // it so their next request doesn't keep retrying with a dead cookie.
      clearSessionCookies(res);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<null> {
    const rawToken = (req.cookies as Record<string, string> | undefined)?.[
      REFRESH_TOKEN_COOKIE
    ];

    await this.logoutUserService.logout(rawToken);
    clearSessionCookies(res);

    return null;
  }

  // Same 5/min throttle rationale as register/login — this is also an
  // enumeration/abuse target, and the response is identical regardless of
  // whether the email is registered (see RequestPasswordResetService).
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('password-reset/request')
  @HttpCode(HttpStatus.OK)
  async requestPasswordReset(
    @Body() dto: RequestPasswordResetDto,
  ): Promise<null> {
    await this.requestPasswordResetService.requestReset(dto);
    return null;
  }

  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmPasswordReset(
    @Body() dto: ConfirmPasswordResetDto,
  ): Promise<null> {
    await this.confirmPasswordResetService.confirmReset(dto);
    return null;
  }

  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() dto: ConfirmEmailVerificationDto): Promise<null> {
    await this.verifyEmailService.verifyEmail(dto);
    return null;
  }

  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('invite/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmInvite(@Body() dto: ConfirmInviteDto): Promise<null> {
    await this.confirmInviteService.confirmInvite(dto);
    return null;
  }

  private useSecureCookies(): boolean {
    return this.configService.get('NODE_ENV', { infer: true }) === 'production';
  }
}
