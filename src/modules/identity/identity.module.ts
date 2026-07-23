import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Env } from '../../config/env.validation';
import { LoginUserService } from './application/login-user.service';
import { RefreshSessionService } from './application/refresh-session.service';
import { RegisterUserService } from './application/register-user.service';
import { TokenIssuanceService } from './application/token-issuance.service';
import { RefreshTokenEntity } from './infrastructure/entities/refresh-token.entity';
import { UserEntity } from './infrastructure/entities/user.entity';
import { AuthController } from './interface/auth.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, RefreshTokenEntity]),
    JwtModule.registerAsync({
      useFactory: (configService: ConfigService<Env, true>) => ({
        secret: configService.get('JWT_ACCESS_SECRET', { infer: true }),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [
    RegisterUserService,
    LoginUserService,
    RefreshSessionService,
    TokenIssuanceService,
  ],
  // Exported so the `admin` module can provision NodeOperator/Rider/Admin
  // accounts through this module's application services later — never by
  // reaching into identity's domain/infrastructure directly.
  exports: [RegisterUserService],
})
export class IdentityModule {}
