import { SetMetadata } from '@nestjs/common';

export const ALLOW_API_KEY_KEY = 'allowApiKey';

// Opt a route in to merchant API-key auth (Authorization: Bearer sk_…/pk_…)
// and declare the scopes a key needs for it. Routes without this decorator
// reject every API key with 401, so a key can never reach consumer, rider,
// Node or admin routes by accident. Cookie sessions are unaffected.
export const AllowApiKey = (
  ...requiredScopes: string[]
): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_API_KEY_KEY, requiredScopes);
