import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AccessTokenPayload } from '../domain/access-token-payload';
import { UnauthenticatedException } from '../domain/exceptions/unauthenticated.exception';
import { AuthenticatedUser } from './authenticated-user';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { ACCESS_TOKEN_COOKIE } from './session-cookies';

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

// Global (registered via APP_GUARD in identity.module.ts) — every route is
// protected by default, opt out with @Public(). Stateless: verifies the JWT
// signature/expiry only, no DB round-trip, which is the whole point of a
// short-lived access token.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = (request.cookies as Record<string, string> | undefined)?.[
      ACCESS_TOKEN_COOKIE
    ];

    if (!token) {
      throw new UnauthenticatedException();
    }

    try {
      const payload =
        await this.jwtService.verifyAsync<AccessTokenPayload>(token);
      request.user = { id: payload.sub, role: payload.role };
    } catch {
      throw new UnauthenticatedException();
    }

    return true;
  }
}
