import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { ApiKeyPrincipal } from './principal';

// Implemented by the merchants module (API keys live there). Resolves a raw
// Bearer key to a principal, or null for unknown/revoked/expired keys and
// keys blocked by an IP allow-list. Never throws for an invalid key — the
// guard owns the uniform 401.
export interface ApiKeyAuthenticator {
  authenticate(
    rawKey: string,
    request: Request,
  ): Promise<ApiKeyPrincipal | null>;
}

// AuthGuard lives in common and can't import the merchants module (boundary
// rules), so the merchants module registers its authenticator here on init
// — same inversion as OutboxHandlerRegistry. Until one is registered every
// API key is rejected.
@Injectable()
export class ApiKeyAuthenticatorRegistry {
  private authenticator: ApiKeyAuthenticator | undefined;

  register(authenticator: ApiKeyAuthenticator): void {
    if (this.authenticator) {
      throw new Error('An ApiKeyAuthenticator is already registered');
    }
    this.authenticator = authenticator;
  }

  get(): ApiKeyAuthenticator | undefined {
    return this.authenticator;
  }
}
