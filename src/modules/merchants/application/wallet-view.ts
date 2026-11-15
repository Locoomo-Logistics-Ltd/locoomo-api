import type { ApiKeyMode } from '../domain/api-key';
import { availableKobo } from '../domain/wallet';
import type { MerchantWalletEntity } from '../infrastructure/entities/merchant-wallet.entity';

export interface WalletView {
  mode: ApiKeyMode;
  currency: 'NGN';
  balanceKobo: number;
  heldKobo: number;
  availableKobo: number;
  // The merchant's low-balance alert line, or null when unset.
  lowBalanceThresholdKobo: number | null;
  updatedAt: string;
}

export const walletView = (w: MerchantWalletEntity): WalletView => ({
  mode: w.mode,
  currency: 'NGN',
  balanceKobo: w.balanceKobo,
  heldKobo: w.heldKobo,
  availableKobo: availableKobo(w),
  lowBalanceThresholdKobo: w.lowBalanceThresholdKobo ?? null,
  updatedAt: (w.updatedAt ?? new Date()).toISOString(),
});
