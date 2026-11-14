import { Global, Module } from '@nestjs/common';
import { ApiKeyAuthenticatorRegistry } from './api-key-authenticator.registry';
import { SessionDenylist } from './session-denylist';

// Global so AuthGuard (registered as APP_GUARD by the identity module) and
// the module that implements API keys (merchants) share one registry.
@Global()
@Module({
  providers: [ApiKeyAuthenticatorRegistry, SessionDenylist],
  exports: [ApiKeyAuthenticatorRegistry, SessionDenylist],
})
export class AuthExtensionsModule {}
