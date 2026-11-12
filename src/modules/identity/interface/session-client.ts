import type { Request } from 'express';
import type { SessionClient } from '../application/token-issuance.service';

export function sessionClientFrom(request: Request): SessionClient {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
}
