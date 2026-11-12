import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { Env } from '../../config/env.validation';
import { CsrfHeaderMissingException } from '../exceptions/csrf-header-missing.exception';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from './session-cookie-names';

export const CSRF_HEADER = 'x-locoomo-client';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Report mode logs each method+path at most once per window so a frontend
// that hasn't adopted the header yet doesn't flood the logs.
const REPORT_WINDOW_MS = 60_000;

// Defence in depth on top of SameSite=Strict session cookies: a mutating
// request that rides on a session cookie must also carry a custom header.
// Browsers can't attach custom headers cross-origin without a CORS
// preflight, which our CORS allow-list refuses for foreign origins — so a
// forged form/image/fetch from another site can never pass.
//
// Applies only when a session cookie is present: API-key callers
// (Authorization: Bearer) and inbound webhooks (Paystack, couriers) never
// send our cookies, so they're exempt by construction rather than by a
// path list that could drift.
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly logger = new Logger(CsrfGuard.name);
  private readonly reported = new Map<string, number>();

  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }
    const mode = this.config.get('CSRF_MODE', { infer: true });
    if (mode === 'off') {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (!requiresHeader(request)) {
      return true;
    }

    if (mode === 'enforce') {
      throw new CsrfHeaderMissingException();
    }

    this.report(request);
    return true;
  }

  private report(request: Request): void {
    const path = request.route
      ? `${request.baseUrl}${(request.route as { path: string }).path}`
      : request.path;
    const key = `${request.method} ${path}`;
    const now = Date.now();
    const last = this.reported.get(key);
    if (last !== undefined && now - last < REPORT_WINDOW_MS) {
      return;
    }
    this.reported.set(key, now);
    this.logger.warn(
      `[CSRF report] ${key} carried a session cookie without the ${CSRF_HEADER} header — will be rejected once CSRF_MODE=enforce`,
    );
  }
}

export function requiresHeader(request: Request): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) {
    return false;
  }
  const cookies = request.cookies as Record<string, string> | undefined;
  const hasSessionCookie =
    !!cookies?.[ACCESS_TOKEN_COOKIE] || !!cookies?.[REFRESH_TOKEN_COOKIE];
  if (!hasSessionCookie) {
    return false;
  }
  const header = request.headers[CSRF_HEADER];
  return typeof header !== 'string' || header.trim().length === 0;
}
