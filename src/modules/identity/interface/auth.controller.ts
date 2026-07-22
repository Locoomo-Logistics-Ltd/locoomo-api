import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { Env } from '../../../config/env.validation';
import { LoginUserService } from '../application/login-user.service';
import { RegisterUserService } from '../application/register-user.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { setSessionCookies } from './session-cookies';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerUserService: RegisterUserService,
    private readonly loginUserService: LoginUserService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto): Promise<UserResponseDto> {
    return this.registerUserService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserResponseDto> {
    const { user, session } = await this.loginUserService.login(dto);

    setSessionCookies(
      res,
      session,
      this.configService.get('NODE_ENV', { infer: true }) === 'production',
    );

    return UserResponseDto.fromEntity(user);
  }
}
