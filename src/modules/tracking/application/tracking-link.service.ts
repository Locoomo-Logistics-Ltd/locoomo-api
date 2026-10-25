import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Env } from '../../../config/env.validation';

// 22 base64url chars = 132 bits of HMAC — far beyond guessing, short enough
// for a link someone might forward on WhatsApp.
const TOKEN_LENGTH = 22;

// Public tracking links carry a token so that knowing (or guessing) a
// tracking code alone isn't enough to see where a parcel is. Stateless: the
// token is an HMAC of the tracking code, recomputed on every request —
// nothing stored, nothing to expire (access is cut off by the tracking
// endpoint's own retention rule instead).
@Injectable()
export class TrackingLinkService {
  constructor(private readonly configService: ConfigService<Env, true>) {}

  tokenFor(trackingCode: string): string {
    return createHmac(
      'sha256',
      this.configService.get('TRACKING_LINK_SECRET', { infer: true }),
    )
      .update(`tracking-link:${trackingCode}`)
      .digest('base64url')
      .slice(0, TOKEN_LENGTH);
  }

  isValidToken(trackingCode: string, token: string): boolean {
    const expected = Buffer.from(this.tokenFor(trackingCode));
    const actual = Buffer.from(token);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  // The frontend's public tracking page, which calls GET /track/:code.
  urlFor(trackingCode: string): string {
    const base = this.configService
      .get('FRONTEND_URL', { infer: true })
      .replace(/\/+$/, '');
    return `${base}/track/${encodeURIComponent(trackingCode)}?t=${this.tokenFor(trackingCode)}`;
  }
}
