import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LogisticsProviderUnavailableException } from '../domain/exceptions/logistics-provider-unavailable.exception';
import {
  LogisticsProviderError,
  WalletBalance,
} from '../domain/ports/logistics-provider.port';
import { LogisticsProviderRegistry } from './logistics-provider.registry';

export interface CourierWallet {
  providerKey: string;
  balanceKobo: number;
  heldKobo: number;
  availableKobo: number;
  // Kept back for surcharges the courier's in-flight deliveries may still
  // add (their quoted fees × the provider's surcharge headroom).
  reservedForSurchargesKobo: number;
  // available − reserved: what new deliveries can really draw on.
  freeKobo: number;
  lowBalanceAlertKobo: number | null;
  lowBalance: boolean;
}

// A prepaid courier's wallet, as Locoomo sees it.
@Injectable()
export class CourierWalletService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: LogisticsProviderRegistry,
  ) {}

  // null for a provider that isn't running or has no prepaid wallet.
  async walletFor(providerKey: string): Promise<CourierWallet | null> {
    const provider = this.registry.get(providerKey);
    if (!provider?.capabilities.prepaidWallet || !provider.getBalanceKobo) {
      return null;
    }

    let balance: WalletBalance;
    try {
      balance = await provider.getBalanceKobo();
    } catch (error) {
      if (error instanceof LogisticsProviderError) {
        throw new LogisticsProviderUnavailableException(
          providerKey,
          'getBalance',
          error.message,
        );
      }
      throw error;
    }

    const [{ inFlightKobo, lowBalanceAlertKobo }] = await this.dataSource.query<
      { inFlightKobo: number; lowBalanceAlertKobo: number | null }[]
    >(
      `SELECT COALESCE((SELECT SUM("quotedKobo") FROM delivery_legs
                         WHERE "providerKey" = $1
                           AND status IN ('requested', 'assigned', 'picked_up', 'returning')), 0)::int
                AS "inFlightKobo",
              "lowBalanceAlertKobo"
         FROM logistics_providers WHERE key = $1`,
      [providerKey],
    );
    const reserved = Math.ceil(
      inFlightKobo * (provider.capabilities.surchargeHeadroomFactor ?? 0),
    );
    const free = balance.availableKobo - reserved;

    return {
      providerKey,
      ...balance,
      reservedForSurchargesKobo: reserved,
      freeKobo: free,
      lowBalanceAlertKobo,
      lowBalance: lowBalanceAlertKobo !== null && free < lowBalanceAlertKobo,
    };
  }
}
