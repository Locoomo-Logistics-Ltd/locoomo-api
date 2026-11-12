import { Global, Module } from '@nestjs/common';
import { ApiKeyAuthenticatorRegistry } from './api-key-authenticator.registry';

// Global so AuthGuard (registered as APP_GUARD by the identity module) and
// the module that implements API keys (merchants) share one registry.
@Global()
@Module({
  providers: [ApiKeyAuthenticatorRegistry],
  exports: [ApiKeyAuthenticatorRegistry],
})
export class AuthExtensionsModule {}
