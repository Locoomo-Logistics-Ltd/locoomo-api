import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Env } from '../../config/env.validation';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConfirmInviteService } from './application/confirm-invite.service';
import { ConfirmPasswordResetService } from './application/confirm-password-reset.service';
import { InviteUserService } from './application/invite-user.service';
import { LoginUserService } from './application/login-user.service';
import { LogoutUserService } from './application/logout-user.service';
import { RefreshSessionService } from './application/refresh-session.service';
import { RegisterUserService } from './application/register-user.service';
import { RequestPasswordResetService } from './application/request-password-reset.service';
import { TokenIssuanceService } from './application/token-issuance.service';
import { VerifyEmailService } from './application/verify-email.service';
import { EmailVerificationTokenEntity } from './infrastructure/entities/email-verification-token.entity';
import { InviteTokenEntity } from './infrastructure/entities/invite-token.entity';
import { PasswordResetTokenEntity } from './infrastructure/entities/password-reset-token.entity';
import { RefreshTokenEntity } from './infrastructure/entities/refresh-token.entity';
import { UserEntity } from './infrastructure/entities/user.entity';
import { AuthController } from './interface/auth.controller';
import { AuthGuard } from './interface/auth.guard';
import { RolesGuard } from './interface/roles.guard';
import { UsersController } from './interface/users.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      RefreshTokenEntity,
      PasswordResetTokenEntity,
      EmailVerificationTokenEntity,
      InviteTokenEntity,
    ]),
    JwtModule.registerAsync({
      useFactory: (configService: ConfigService<Env, true>) => ({
        secret: configService.get('JWT_ACCESS_SECRET', { infer: true }),
      }),
      inject: [ConfigService],
    }),
    NotificationsModule,
  ],
  controllers: [AuthController, UsersController],
  providers: [
    RegisterUserService,
    LoginUserService,
    LogoutUserService,
    RefreshSessionService,
    RequestPasswordResetService,
    ConfirmPasswordResetService,
    VerifyEmailService,
    InviteUserService,
    ConfirmInviteService,
    TokenIssuanceService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  // Exported so the `admin` module can provision NodeOperator/Rider/Admin
  // accounts through this module's application services later — never by
  // reaching into identity's domain/infrastructure directly.
  exports: [RegisterUserService],
})
export class IdentityModule {}
