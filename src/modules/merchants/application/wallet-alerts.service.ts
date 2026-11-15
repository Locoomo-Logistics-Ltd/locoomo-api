import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { defaultTierFor, resolveLimits } from '../domain/merchant-limits';
import { availableKobo } from '../domain/wallet';
import { MerchantWalletEntity } from '../infrastructure/entities/merchant-wallet.entity';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import { MerchantNotifierService } from './merchant-notifier.service';
import { walletView } from './wallet-view';
import { WebhookEmitterService } from './webhook-emitter.service';

// Wallet alerts (plan §8.4), checked after every change to a wallet's
// balance or holds, inside that change's transaction. Each fires once when
// its line is crossed and re-arms when the wallet recovers:
// - low balance: available below the merchant's own threshold → the team is
//   emailed and gets `wallet.low_balance`;
// - negative floor (live): balance below the tier's floor → finance admins
//   are emailed (new shipments are already refused below zero).
@Injectable()
export class WalletAlertsService {
  constructor(
    private readonly emitter: WebhookEmitterService,
    private readonly notifier: MerchantNotifierService,
  ) {}

  async check(
    manager: EntityManager,
    wallet: MerchantWalletEntity,
  ): Promise<void> {
    const available = availableKobo(wallet);
    let changed = false;
    let merchant: MerchantEntity | null = null;
    const merchantOf = async (): Promise<MerchantEntity> =>
      (merchant ??= await manager.findOneByOrFail(MerchantEntity, {
        id: wallet.merchantId,
      }));

    const threshold = wallet.lowBalanceThresholdKobo;
    if (threshold !== null) {
      if (available < threshold && !wallet.lowBalanceAlertedAt) {
        wallet.lowBalanceAlertedAt = new Date();
        changed = true;
        await this.emitter.emit(manager, {
          merchantId: wallet.merchantId,
          mode: wallet.mode,
          type: 'wallet.low_balance',
          data: { wallet: walletView(wallet), thresholdKobo: threshold },
        });
        await this.notifier.walletLowBalance(
          await merchantOf(),
          wallet,
          manager,
        );
      } else if (available >= threshold && wallet.lowBalanceAlertedAt) {
        wallet.lowBalanceAlertedAt = null;
        changed = true;
      }
    }

    if (wallet.mode === 'live') {
      const m = await merchantOf();
      const floor = resolveLimits(
        m.tier ?? defaultTierFor(m.type),
        m.limitOverrides,
      ).negativeBalanceFloorKobo;
      if (
        floor !== null &&
        wallet.balanceKobo < floor &&
        !wallet.floorAlertedAt
      ) {
        wallet.floorAlertedAt = new Date();
        changed = true;
        await this.notifier.walletBelowFloor(m, wallet, floor, manager);
      } else if (
        wallet.floorAlertedAt &&
        (floor === null || wallet.balanceKobo >= floor)
      ) {
        wallet.floorAlertedAt = null;
        changed = true;
      }
    }

    if (changed) {
      await manager.update(
        MerchantWalletEntity,
        { id: wallet.id },
        {
          lowBalanceAlertedAt: wallet.lowBalanceAlertedAt,
          floorAlertedAt: wallet.floorAlertedAt,
        },
      );
    }
  }
}
