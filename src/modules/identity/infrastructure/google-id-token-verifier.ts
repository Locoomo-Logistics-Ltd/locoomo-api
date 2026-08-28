import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { Env } from '../../../config/env.validation';

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  givenName?: string;
  familyName?: string;
  name?: string;
}

// Sole boundary to Google's ID-token verification — RS256/JWKS signature
// checking via the official `google-auth-library`, not hand-rolled (same
// no-vendor-SDK exception CLAUDE.md already carves out for Cloudinary's
// private-delivery URL signing: this is security-critical vendor-specific
// crypto, not a place to save a dependency). Separated out from
// GoogleAuthService specifically so e2e tests can override just this class
// (matching how PaystackBankService/CloudinaryService are faked wholesale
// at their own external-call boundary) while exercising the real
// signup/login/collision logic in GoogleAuthService.
@Injectable()
export class GoogleIdTokenVerifier {
  private readonly client: OAuth2Client;
  private readonly clientId: string;

  constructor(configService: ConfigService<Env, true>) {
    this.clientId = configService.get('GOOGLE_CLIENT_ID', { infer: true });
    this.client = new OAuth2Client(this.clientId);
  }

  // Returns null on any verification failure (bad signature, wrong
  // audience, expired, malformed) — GoogleAuthService treats "couldn't
  // verify" as one uniform case regardless of the underlying cause.
  async verify(idToken: string): Promise<GoogleIdentity | null> {
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.clientId,
      });
      const payload = ticket.getPayload();

      if (!payload || !payload.sub || !payload.email) {
        return null;
      }

      return {
        sub: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified === true,
        givenName: payload.given_name,
        familyName: payload.family_name,
        name: payload.name,
      };
    } catch {
      return null;
    }
  }
}
