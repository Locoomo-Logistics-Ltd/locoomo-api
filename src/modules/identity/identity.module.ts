import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthGuard } from '../../common/auth/auth.guard';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Env } from '../../config/env.validation';
import { NotificationsModule } from '../notifications/notifications.module';
import { ActivateUserService } from './application/activate-user.service';
import { ConfirmInviteService } from './application/confirm-invite.service';
import { ConfirmPasswordResetService } from './application/confirm-password-reset.service';
import { GoogleAuthService } from './application/google-auth.service';
import { InviteUserService } from './application/invite-user.service';
import { LoginUserService } from './application/login-user.service';
import { LogoutUserService } from './application/logout-user.service';
import { MyProfileService } from './application/my-profile.service';
import { RefreshSessionService } from './application/refresh-session.service';
import { RegisterUserService } from './application/register-user.service';
import { RequestPasswordResetService } from './application/request-password-reset.service';
import { TokenIssuanceService } from './application/token-issuance.service';
import { UserLookupService } from './application/user-lookup.service';
import { VerifyEmailService } from './application/verify-email.service';
import { EmailVerificationTokenEntity } from './infrastructure/entities/email-verification-token.entity';
import { InviteTokenEntity } from './infrastructure/entities/invite-token.entity';
import { PasswordResetTokenEntity } from './infrastructure/entities/password-reset-token.entity';
import { RefreshTokenEntity } from './infrastructure/entities/refresh-token.entity';
import { UserEntity } from './infrastructure/entities/user.entity';
import { GoogleIdTokenVerifier } from './infrastructure/google-id-token-verifier';
import { AuthController } from './interface/auth.controller';
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
    ActivateUserService,
    UserLookupService,
    GoogleAuthService,
    GoogleIdTokenVerifier,
    MyProfileService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  // RegisterUserService: exported so the `admin` module can provision
  // NodeOperator/Rider/Admin accounts through this module's application
  // services later. ActivateUserService: exported so `node-operators`' Admin
  // approval flow can flip User.status=ACTIVE in the same transaction as
  // Node.status=ACTIVE — never by reaching into identity's
  // domain/infrastructure directly. UserLookupService: exported so
  // `payments` can resolve a consumer's email for Paystack's initialize
  // call without importing UserEntity. InviteUserService: exported so
  // `node-operators` can provision a NODE_STAFF account for its own
  // owner-invite flow — only `.inviteNodeStaff()` is meant for cross-module
  // use, same convention as the exports above.
  exports: [
    RegisterUserService,
    ActivateUserService,
    UserLookupService,
    InviteUserService,
  ],
})
export class IdentityModule {}
