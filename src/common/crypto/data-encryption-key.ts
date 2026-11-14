import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { SecretBox } from './secret-box';

// One place that decides the key material for encrypted-at-rest fields:
// DATA_ENCRYPTION_KEY, or (only so existing deploys boot) JWT_ACCESS_SECRET.
// Each caller passes its own `purpose`, so the derived keys differ — a
// leaked TOTP key can't open KYC data and vice versa.
export function createSecretBox(
  config: ConfigService<Env, true>,
  purpose: 'totp-seed' | 'merchant-kyc' | 'bank-account' | 'webhook-secret',
): SecretBox {
  return new SecretBox(
    config.get('DATA_ENCRYPTION_KEY', { infer: true }) ??
      config.get('JWT_ACCESS_SECRET', { infer: true }),
    purpose,
  );
}
