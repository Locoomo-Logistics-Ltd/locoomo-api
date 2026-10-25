import { Injectable } from '@nestjs/common';
import type { LogisticsProvider } from '../domain/ports/logistics-provider.port';

// Every courier adapter registers itself here at startup (OnModuleInit),
// keyed by LogisticsProvider.key — the same key as its logistics_providers
// row. Routing only ever offers a provider that is both configured *and*
// registered.
@Injectable()
export class LogisticsProviderRegistry {
  private readonly providers = new Map<string, LogisticsProvider>();

  register(provider: LogisticsProvider): void {
    if (this.providers.has(provider.key)) {
      throw new Error(`Logistics provider already registered: ${provider.key}`);
    }
    this.providers.set(provider.key, provider);
  }

  get(key: string): LogisticsProvider | undefined {
    return this.providers.get(key);
  }
}
