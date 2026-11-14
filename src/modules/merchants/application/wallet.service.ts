import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  CursorPage,
  CursorPosition,
  cursorTime,
  decodeCursor,
  toCursorPage,
} from '../../../common/pagination/cursor';
import type { ApiKeyMode } from '../domain/api-key';
import { InsufficientWalletBalanceException } from '../domain/exceptions/merchant.exceptions';
import {
  availableKobo,
  HoldStatus,
  TEST_WALLET_FUNDING_KOBO,
  WalletEntryType,
} from '../domain/wallet';
import { MerchantWalletEntity } from '../infrastructure/entities/merchant-wallet.entity';
import { WalletEntryEntity } from '../infrastructure/entities/wallet-entry.entity';
import { WalletHoldEntity } from '../infrastructure/entities/wallet-hold.entity';

export interface WalletView {
  mode: ApiKeyMode;
  currency: 'NGN';
  balanceKobo: number;
  heldKobo: number;
  availableKobo: number;
  updatedAt: string;
}

export interface WalletEntryView {
  id: string;
  type: WalletEntryType;
  amountKobo: number;
  balanceAfterKobo: number;
  description: string;
  shipmentId: string | null;
  createdAt: string;
}

export interface WalletHoldView {
  id: string;
  shipmentId: string;
  status: HoldStatus;
  amountKobo: number;
  capturedKobo: number | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface EntryFilter {
  type?: WalletEntryType;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

interface Movement {
  type: WalletEntryType;
  amountKobo: number;
  description: string;
  shipmentId?: string | null;
  holdId?: string | null;
  approvalId?: string | null;
  createdByUserId?: string | null;
  externalRef?: string | null;
}

export const walletView = (w: MerchantWalletEntity): WalletView => ({
  mode: w.mode,
  currency: 'NGN',
  balanceKobo: w.balanceKobo,
  heldKobo: w.heldKobo,
  availableKobo: availableKobo(w),
  updatedAt: w.updatedAt.toISOString(),
});

type RawEntry = Omit<WalletEntryView, 'createdAt'> & { createdAt: Date };
type RawHold = Omit<WalletHoldView, 'createdAt' | 'resolvedAt'> & {
  createdAt: Date;
  resolvedAt: Date | null;
};

const position = (row: { createdAt: Date; id: string }): CursorPosition => ({
  t: row.createdAt.toISOString(),
  id: row.id,
});

// Several entries are often written in one transaction (same timestamp).
const ms = (alias: string): string => cursorTime(`${alias}."createdAt"`);

function afterCursor(
  alias: string,
  cursor: string | undefined,
  params: unknown[],
  where: string[],
): void {
  const after = decodeCursor(cursor);
  if (after) {
    params.push(after.t, after.id);
    where.push(
      `(${ms(alias)}, ${alias}.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }
}

// The merchant wallet (plan §8.1, E2). Every write runs inside the caller's
// transaction with the wallet row locked (FOR UPDATE), so a shipment change
// and its money move commit or roll back together. Lock order: shipment
// first (callers already hold it), then wallet.
@Injectable()
export class WalletService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  // ─── Reads ────────────────────────────────────────────────────────────

  async summary(merchantId: string, mode: ApiKeyMode): Promise<WalletView> {
    const wallet = await this.dataSource.transaction((manager) =>
      this.walletFor(manager, merchantId, mode, false),
    );
    return walletView(wallet);
  }

  async entries(
    merchantId: string,
    mode: ApiKeyMode,
    filter: EntryFilter,
  ): Promise<CursorPage<WalletEntryView>> {
    const params: unknown[] = [merchantId, mode, filter.limit + 1];
    const where = [`e."merchantId" = $1`, `e.mode = $2`];
    if (filter.type) {
      params.push(filter.type);
      where.push(`e.type = $${params.length}`);
    }
    if (filter.from) {
      params.push(filter.from);
      where.push(`e."createdAt" >= $${params.length}::timestamptz`);
    }
    if (filter.to) {
      params.push(filter.to);
      where.push(`e."createdAt" < $${params.length}::timestamptz`);
    }
    afterCursor('e', filter.cursor, params, where);
    const rows = await this.dataSource.query<RawEntry[]>(
      `SELECT e.id, e.type, e."amountKobo"::float8 AS "amountKobo",
              e."balanceAfterKobo"::float8 AS "balanceAfterKobo",
              e.description, e."shipmentId", e."createdAt"
         FROM wallet_entries e
        WHERE ${where.join(' AND ')}
        ORDER BY ${ms('e')} DESC, e.id DESC
        LIMIT $3`,
      params,
    );
    return toCursorPage<RawEntry, WalletEntryView>(
      rows,
      filter.limit,
      position,
      (row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      }),
    );
  }

  async holds(
    merchantId: string,
    mode: ApiKeyMode,
    status: HoldStatus | undefined,
    limit: number,
    cursor?: string,
  ): Promise<CursorPage<WalletHoldView>> {
    const params: unknown[] = [merchantId, mode, limit + 1];
    const where = [`h."merchantId" = $1`, `h.mode = $2`];
    if (status) {
      params.push(status);
      where.push(`h.status = $${params.length}`);
    }
    afterCursor('h', cursor, params, where);
    const rows = await this.dataSource.query<RawHold[]>(
      `SELECT h.id, h."shipmentId", h.status, h."amountKobo"::float8 AS "amountKobo",
              h."capturedKobo"::float8 AS "capturedKobo", h."createdAt", h."resolvedAt"
         FROM wallet_holds h
        WHERE ${where.join(' AND ')}
        ORDER BY ${ms('h')} DESC, h.id DESC
        LIMIT $3`,
      params,
    );
    return toCursorPage<RawHold, WalletHoldView>(
      rows,
      limit,
      position,
      (row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
      }),
    );
  }

  // ─── Holds (shipment fees) ────────────────────────────────────────────

  // Sets the quoted fee aside. 402 when it isn't available.
  async placeHold(
    manager: EntityManager,
    input: {
      merchantId: string;
      mode: ApiKeyMode;
      shipmentId: string;
      amountKobo: number;
    },
  ): Promise<WalletHoldEntity> {
    const wallet = await this.walletFor(
      manager,
      input.merchantId,
      input.mode,
      true,
    );
    this.assertAvailable(wallet, input.amountKobo);
    wallet.heldKobo += input.amountKobo;
    await manager.save(wallet);
    return manager.save(
      manager.create(WalletHoldEntity, {
        walletId: wallet.id,
        merchantId: input.merchantId,
        mode: input.mode,
        shipmentId: input.shipmentId,
        status: 'active',
        amountKobo: input.amountKobo,
        capturedKobo: null,
        resolvedAt: null,
      }),
    );
  }

  // Re-quote before drop-off: grows (402 if unaffordable) or shrinks.
  async changeHold(
    manager: EntityManager,
    shipmentId: string,
    newAmountKobo: number,
  ): Promise<void> {
    const { hold, wallet } = await this.activeHold(manager, shipmentId);
    const difference = newAmountKobo - hold.amountKobo;
    if (difference === 0) {
      return;
    }
    if (difference > 0) {
      this.assertAvailable(wallet, difference);
    }
    wallet.heldKobo += difference;
    hold.amountKobo = newAmountKobo;
    await manager.save(wallet);
    await manager.save(hold);
  }

  // Cancelled, expired or refused: nothing is charged.
  async releaseHold(manager: EntityManager, shipmentId: string): Promise<void> {
    const found = await this.activeHold(manager, shipmentId, false);
    if (!found) {
      return;
    }
    const { hold, wallet } = found;
    wallet.heldKobo -= hold.amountKobo;
    hold.status = 'released';
    hold.resolvedAt = new Date();
    await manager.save(wallet);
    await manager.save(hold);
  }

  // Parcel received: charge the final fee. Never refuses (the parcel is
  // already with us); the balance may go negative (plan §8.4).
  async captureHold(
    manager: EntityManager,
    shipmentId: string,
    chargeKobo: number,
    description: string,
  ): Promise<void> {
    const { hold, wallet } = await this.activeHold(manager, shipmentId);
    wallet.heldKobo -= hold.amountKobo;
    hold.status = 'captured';
    hold.capturedKobo = chargeKobo;
    hold.resolvedAt = new Date();
    await manager.save(hold);
    if (chargeKobo > 0) {
      await this.post(manager, wallet, {
        type: WalletEntryType.SHIPMENT_CHARGE,
        amountKobo: -chargeKobo,
        description,
        shipmentId,
        holdId: hold.id,
      });
    } else {
      await manager.save(wallet);
    }
  }

  // After capture: re-priced on measurement. `differenceKobo` > 0 charges
  // more, < 0 refunds.
  async adjustShipmentCharge(
    manager: EntityManager,
    input: {
      merchantId: string;
      mode: ApiKeyMode;
      shipmentId: string;
      differenceKobo: number;
      description: string;
    },
  ): Promise<void> {
    if (input.differenceKobo === 0) {
      return;
    }
    const wallet = await this.walletFor(
      manager,
      input.merchantId,
      input.mode,
      true,
    );
    await this.post(manager, wallet, {
      type: WalletEntryType.SHIPMENT_ADJUSTMENT,
      amountKobo: -input.differenceKobo,
      description: input.description,
      shipmentId: input.shipmentId,
    });
  }

  // ─── Other movements ──────────────────────────────────────────────────

  // An approved admin adjustment (maker-checker, E12).
  async adjust(
    manager: EntityManager,
    input: {
      merchantId: string;
      mode: ApiKeyMode;
      amountKobo: number;
      description: string;
      approvalId: string;
      createdByUserId: string;
    },
  ): Promise<WalletEntryEntity> {
    const wallet = await this.walletFor(
      manager,
      input.merchantId,
      input.mode,
      true,
    );
    return this.post(manager, wallet, {
      type: WalletEntryType.ADJUSTMENT,
      amountKobo: input.amountKobo,
      description: input.description,
      approvalId: input.approvalId,
      createdByUserId: input.createdByUserId,
    });
  }

  // Money from outside (a Paystack charge). Idempotent on `externalRef`:
  // returns null when that charge was already credited.
  async creditExternal(
    manager: EntityManager,
    input: {
      merchantId: string;
      mode: ApiKeyMode;
      type: WalletEntryType;
      amountKobo: number;
      description: string;
      externalRef: string;
      createdByUserId?: string | null;
    },
  ): Promise<{
    entry: WalletEntryEntity;
    wallet: MerchantWalletEntity;
  } | null> {
    const wallet = await this.walletFor(
      manager,
      input.merchantId,
      input.mode,
      true,
    );
    // Checked under the wallet lock, so two deliveries of one charge can't
    // both pass (the unique index is the backstop).
    const existing = await manager.findOne(WalletEntryEntity, {
      where: { externalRef: input.externalRef },
      select: { id: true },
    });
    if (existing || input.amountKobo <= 0) {
      return null;
    }
    const entry = await this.post(manager, wallet, {
      type: input.type,
      amountKobo: input.amountKobo,
      description: input.description,
      externalRef: input.externalRef,
      createdByUserId: input.createdByUserId ?? null,
    });
    return { entry, wallet };
  }

  // Test mode: back to ₦1,000,000. Holds stay (their shipments still exist).
  async resetTestWallet(
    manager: EntityManager,
    merchantId: string,
    userId: string | null,
  ): Promise<MerchantWalletEntity> {
    const wallet = await this.walletFor(manager, merchantId, 'test', true);
    const topUp = TEST_WALLET_FUNDING_KOBO - wallet.balanceKobo;
    if (topUp !== 0) {
      await this.post(manager, wallet, {
        type: WalletEntryType.TEST_FUNDING,
        amountKobo: topUp,
        description: 'Test wallet reset',
        createdByUserId: userId,
      });
    }
    return wallet;
  }

  // ─── Internals ────────────────────────────────────────────────────────

  // The merchant's wallet for this mode, created on first use (a test
  // wallet starts funded). Locked when `lock`.
  async walletFor(
    manager: EntityManager,
    merchantId: string,
    mode: ApiKeyMode,
    lock: boolean,
  ): Promise<MerchantWalletEntity> {
    const find = (): Promise<MerchantWalletEntity | null> => {
      const qb = manager
        .getRepository(MerchantWalletEntity)
        .createQueryBuilder('w')
        .where('w.merchantId = :merchantId AND w.mode = :mode', {
          merchantId,
          mode,
        });
      if (lock) {
        qb.setLock('pessimistic_write');
      }
      return qb.getOne();
    };
    const existing = await find();
    if (existing) {
      return existing;
    }
    const funding = mode === 'test' ? TEST_WALLET_FUNDING_KOBO : 0;
    const inserted = await manager.query<{ id: string }[]>(
      `INSERT INTO merchant_wallets ("merchantId", mode, "balanceKobo")
       VALUES ($1, $2, $3)
       ON CONFLICT ("merchantId", mode) DO NOTHING
       RETURNING id`,
      [merchantId, mode, funding],
    );
    if (inserted.length > 0 && funding > 0) {
      await manager.insert(WalletEntryEntity, {
        walletId: inserted[0].id,
        merchantId,
        mode,
        type: WalletEntryType.TEST_FUNDING,
        amountKobo: funding,
        balanceAfterKobo: funding,
        description: 'Test wallet funding',
      });
    }
    const created = await find();
    if (!created) {
      throw new Error(`Wallet for merchant ${merchantId} (${mode}) vanished`);
    }
    return created;
  }

  // Posts one ledger line and updates the cached balance. `wallet` must be
  // locked by the caller.
  private async post(
    manager: EntityManager,
    wallet: MerchantWalletEntity,
    movement: Movement,
  ): Promise<WalletEntryEntity> {
    wallet.balanceKobo += movement.amountKobo;
    await manager.save(wallet);
    return manager.save(
      manager.create(WalletEntryEntity, {
        walletId: wallet.id,
        merchantId: wallet.merchantId,
        mode: wallet.mode,
        type: movement.type,
        amountKobo: movement.amountKobo,
        balanceAfterKobo: wallet.balanceKobo,
        description: movement.description.slice(0, 300),
        shipmentId: movement.shipmentId ?? null,
        holdId: movement.holdId ?? null,
        approvalId: movement.approvalId ?? null,
        createdByUserId: movement.createdByUserId ?? null,
        externalRef: movement.externalRef ?? null,
      }),
    );
  }

  private assertAvailable(
    wallet: MerchantWalletEntity,
    requiredKobo: number,
  ): void {
    const available = availableKobo(wallet);
    if (requiredKobo > available) {
      throw new InsufficientWalletBalanceException(
        requiredKobo,
        Math.max(available, 0),
      );
    }
  }

  private async activeHold(
    manager: EntityManager,
    shipmentId: string,
  ): Promise<{ hold: WalletHoldEntity; wallet: MerchantWalletEntity }>;
  private async activeHold(
    manager: EntityManager,
    shipmentId: string,
    required: false,
  ): Promise<{ hold: WalletHoldEntity; wallet: MerchantWalletEntity } | null>;
  private async activeHold(
    manager: EntityManager,
    shipmentId: string,
    required = true,
  ): Promise<{ hold: WalletHoldEntity; wallet: MerchantWalletEntity } | null> {
    const hold = await manager
      .getRepository(WalletHoldEntity)
      .createQueryBuilder('h')
      .where('h.shipmentId = :shipmentId AND h.status = :status', {
        shipmentId,
        status: 'active',
      })
      .setLock('pessimistic_write')
      .getOne();
    if (!hold) {
      if (required) {
        throw new Error(`No active wallet hold for shipment ${shipmentId}`);
      }
      return null;
    }
    const wallet = await this.walletFor(
      manager,
      hold.merchantId,
      hold.mode,
      true,
    );
    return { hold, wallet };
  }
}
