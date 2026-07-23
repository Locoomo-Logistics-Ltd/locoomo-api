import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Env } from '../../config/env.validation';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConfirmPasswordResetService } from './application/confirm-password-reset.service';
import { LoginUserService } from './application/login-user.service';
import { LogoutUserService } from './application/logout-user.service';
import { RefreshSessionService } from './application/refresh-session.service';
import { RegisterUserService } from './application/register-user.service';
import { RequestPasswordResetService } from './application/request-password-reset.service';
import { TokenIssuanceService } from './application/token-issuance.service';
import { PasswordResetTokenEntity } from './infrastructure/entities/password-reset-token.entity';
import { RefreshTokenEntity } from './infrastructure/entities/refresh-token.entity';
import { UserEntity } from './infrastructure/entities/user.entity';
import { AuthController } from './interface/auth.controller';
import { AuthGuard } from './interface/auth.guard';
import { RolesGuard } from './interface/roles.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      RefreshTokenEntity,
      PasswordResetTokenEntity,
    ]),
    JwtModule.registerAsync({
      useFactory: (configService: ConfigService<Env, true>) => ({
        secret: configService.get('JWT_ACCESS_SECRET', { infer: true }),
      }),
      inject: [ConfigService],
    }),
    NotificationsModule,
  ],
  controllers: [AuthController],
  providers: [
    RegisterUserService,
    LoginUserService,
    LogoutUserService,
    RefreshSessionService,
    RequestPasswordResetService,
    ConfirmPasswordResetService,
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
