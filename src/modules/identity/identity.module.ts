import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RegisterUserService } from './application/register-user.service';
import { RefreshTokenEntity } from './infrastructure/entities/refresh-token.entity';
import { UserEntity } from './infrastructure/entities/user.entity';
import { AuthController } from './interface/auth.controller';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, RefreshTokenEntity])],
  controllers: [AuthController],
  providers: [RegisterUserService],
  // Exported so the `admin` module can provision NodeOperator/Rider/Admin
  // accounts through this module's application services later — never by
  // reaching into identity's domain/infrastructure directly.
  exports: [RegisterUserService],
})
export class IdentityModule {}
