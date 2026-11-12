import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  InsufficientScopeException,
  InvalidApiKeyException,
} from '../exceptions/api-key.exceptions';
import { UnauthenticatedException } from '../exceptions';
import { AccessTokenPayload } from './access-token-payload';
import { ApiKeyAuthenticatorRegistry } from './api-key-authenticator.registry';
import { AuthenticatedUser } from './authenticated-user';
import { ALLOW_API_KEY_KEY } from './decorators/allow-api-key.decorator';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { looksLikeApiKey, Principal } from './principal';
import { ACCESS_TOKEN_COOKIE } from './session-cookie-names';

export interface RequestWithUser extends Request {
  // Cookie sessions only — API-key callers never populate this.
  user?: AuthenticatedUser;
  // Every authenticated caller (cookie user or API key).
  principal?: Principal;
}

// Global (registered via APP_GUARD in identity.module.ts) — every route is
// protected by default, opt out with @Public().
//
// Two ways in:
//  - Cookie session (browser apps): stateless JWT verification, no DB
//    round-trip — the whole point of a short-lived access token.
//  - Merchant API key (Authorization: Bearer sk_…/pk_…): only on routes
//    that opt in with @AllowApiKey(scopes); anywhere else a key is a 401.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly apiKeyAuthenticators: ApiKeyAuthenticatorRegistry,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      targets,
    );
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();

    const bearer = extractBearerToken(request);
    if (bearer && looksLikeApiKey(bearer)) {
      const requiredScopes = this.reflector.getAllAndOverride<
        string[] | undefined
      >(ALLOW_API_KEY_KEY, targets);
      await this.authenticateApiKey(request, bearer, requiredScopes);
      return true;
    }

    await this.authenticateSession(request);
    return true;
  }

  private async authenticateApiKey(
    request: RequestWithUser,
    rawKey: string,
    requiredScopes: string[] | undefined,
  ): Promise<void> {
    // Route didn't opt in: same 401 as no credentials at all, so a key
    // can't be used to discover which non-merchant routes exist.
    if (!requiredScopes) {
      throw new UnauthenticatedException();
    }

    const authenticator = this.apiKeyAuthenticators.get();
    const principal = authenticator
      ? await authenticator.authenticate(rawKey, request)
      : null;
    if (!principal) {
      throw new InvalidApiKeyException();
    }

    const missing = requiredScopes.filter(
      (scope) => !principal.scopes.includes(scope),
    );
    if (missing.length > 0) {
      throw new InsufficientScopeException(missing);
    }

    request.principal = principal;
  }

  private async authenticateSession(request: RequestWithUser): Promise<void> {
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
      request.principal = {
        kind: 'user',
        userId: payload.sub,
        role: payload.role,
      };
    } catch {
      throw new UnauthenticatedException();
    }
  }
}

function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}
