import { randomUUID } from 'crypto';
import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import {
  CursorPage,
  CursorPosition,
  cursorTime,
  decodeCursor,
  toCursorPage,
} from '../../../common/pagination/cursor';
import { shouldRunBackgroundJobs } from '../../../common/process/background-jobs';
import { Env } from '../../../config/env.validation';
import { UserLookupService } from '../../identity/application/user-lookup.service';
import { PaymentWebhookRouter } from '../../payments/application/payment-webhook-router';
import {
  PaystackKeyEnv,
  PaystackWalletGateway,
  WalletCharge,
} from '../../payments/application/paystack-wallet.gateway';
import type { PaymentWebhookEvent } from '../../payments/application/payment-webhook-router';
import type { ApiKeyMode } from '../domain/api-key';
import {
  ContactDetailsRequiredException,
  FundingAccountConflictException,
  LiveModeOnlyException,
  MerchantNotApprovedException,
  MerchantNotEditableException,
  TopUpsUnavailableException,
  WalletBalanceLimitException,
} from '../domain/exceptions/merchant.exceptions';
import { MerchantStatus } from '../domain/merchant.enums';
import { defaultTierFor, resolveLimits } from '../domain/merchant-limits';
import {
  cardTopUpReference,
  creditedAmount,
  exceedsWalletCeiling,
  paystackExternalRef,
  TopUpMethod,
  TopUpStatus,
  WalletEntryType,
} from '../domain/wallet';
import { MerchantFundingAccountEntity } from '../infrastructure/entities/merchant-funding-account.entity';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import { WalletTopUpEntity } from '../infrastructure/entities/wallet-top-up.entity';
import { MerchantNotifierService } from './merchant-notifier.service';
import type { MerchantCaller } from './merchant-state';
import { WalletService, walletView } from './wallet.service';
import { WebhookEmitterService } from './webhook-emitter.service';

const SWEEP_INTERVAL_NAME = 'wallet-top-up-sweep';
const SWEEP_EVERY_MS = 15 * 60 * 1000;
// Card payments are left alone this long before the sweep asks Paystack.
const CARD_SETTLE_MS = 2 * 60 * 1000;
// …and given up on (abandoned) after this. A late success still credits.
const CARD_ABANDON_MS = 24 * 60 * 60 * 1000;
// Transfers are re-read this far back on every sweep (late settlement).
const TRANSFER_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 200;
const DEDICATED_ACCOUNT_CHANNEL = 'dedicated_nuban';

export interface TopUpView {
  id: string;
  mode: ApiKeyMode;
  method: TopUpMethod;
  status: TopUpStatus;
  amountKobo: number;
  feeKobo: number;
  creditedKobo: number | null;
  reference: string;
  paidAt: string | null;
  createdAt: string;
}

export interface FundingAccountView {
  bankName: string;
  accountNumber: string;
  accountName: string;
  createdAt: string;
}

export const topUpView = (t: WalletTopUpEntity): TopUpView => ({
  id: t.id,
  mode: t.mode,
  method: t.method,
  status: t.status,
  amountKobo: t.amountKobo,
  feeKobo: t.feeKobo,
  creditedKobo: t.creditedKobo,
  reference: t.reference,
  paidAt: t.paidAt?.toISOString() ?? null,
  createdAt: t.createdAt.toISOString(),
});

const fundingAccountView = (
  a: MerchantFundingAccountEntity,
): FundingAccountView => ({
  bankName: a.bankName,
  accountNumber: a.accountNumber,
  accountName: a.accountName,
  createdAt: a.createdAt.toISOString(),
});

const envFor = (mode: ApiKeyMode): PaystackKeyEnv =>
  mode === 'live' ? 'live' : 'test';

export interface SweepResult {
  credited: number;
  failed: number;
  abandoned: number;
}

// Wallet top-ups (plan §8.2): card payments through Paystack checkout, and
// bank transfers into the merchant's Dedicated Virtual Account. Money is
// credited only after re-verifying the charge with Paystack, exactly once
// per Paystack reference, whether the news came from a webhook, the
// dashboard's status check or the sweep.
@Injectable()
export class WalletTopUpService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WalletTopUpService.name);
  private sweeping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly gateway: PaystackWalletGateway,
    private readonly router: PaymentWebhookRouter,
    private readonly wallet: WalletService,
    private readonly emitter: WebhookEmitterService,
    private readonly notifier: MerchantNotifierService,
    private readonly users: UserLookupService,
    private readonly scheduler: SchedulerRegistry,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.router.register({
      handle: (event, manager) => this.handleWebhook(event, manager),
    });
    if (shouldRunBackgroundJobs(this.config)) {
      this.scheduler.addInterval(
        SWEEP_INTERVAL_NAME,
        setInterval(() => void this.tick(), SWEEP_EVERY_MS),
      );
    }
  }

  onApplicationShutdown(): void {
    if (this.scheduler.doesExist('interval', SWEEP_INTERVAL_NAME)) {
      this.scheduler.deleteInterval(SWEEP_INTERVAL_NAME);
    }
  }

  // ─── Card top-ups ─────────────────────────────────────────────────────

  async startCardTopUp(
    caller: MerchantCaller,
    amountKobo: number,
  ): Promise<{ topUp: TopUpView; authorizationUrl: string }> {
    const merchant = await this.fundableMerchant(caller);
    const env = envFor(caller.mode);
    if (!this.gateway.isAvailable(env)) {
      throw new TopUpsUnavailableException();
    }
    if (caller.mode === 'live') {
      const { balanceKobo } = await this.wallet.summary(
        caller.merchantId,
        'live',
      );
      const { maxWalletBalanceKobo } = resolveLimits(
        merchant.tier ?? defaultTierFor(merchant.type),
        merchant.limitOverrides,
      );
      if (exceedsWalletCeiling(balanceKobo, amountKobo, maxWalletBalanceKobo)) {
        throw new WalletBalanceLimitException(
          maxWalletBalanceKobo!,
          balanceKobo,
        );
      }
    }
    const [payer] = await this.users.getContacts([caller.userId!]);

    const id = randomUUID();
    const topUp = await this.dataSource.manager.save(
      this.dataSource.manager.create(WalletTopUpEntity, {
        id,
        merchantId: caller.merchantId,
        mode: caller.mode,
        method: 'card',
        status: 'pending',
        reference: cardTopUpReference(id),
        amountKobo,
        feeKobo: 0,
        creditedKobo: null,
        authorizationUrl: null,
        entryId: null,
        createdByUserId: caller.userId,
        paidAt: null,
      }),
    );
    try {
      const { authorizationUrl } = await this.gateway.initializeCardTopUp(env, {
        reference: topUp.reference,
        amountKobo,
        email: payer.email,
        callbackUrl: this.notifier.dashboardUrl(`/wallet?topUp=${topUp.id}`),
        merchantId: caller.merchantId,
        mode: caller.mode,
      });
      topUp.authorizationUrl = authorizationUrl;
      await this.dataSource.manager.save(topUp);
      return { topUp: topUpView(topUp), authorizationUrl };
    } catch (error) {
      topUp.status = 'failed';
      await this.dataSource.manager.save(topUp);
      throw error;
    }
  }

  async list(
    merchantId: string,
    mode: ApiKeyMode,
    limit: number,
    cursor?: string,
  ): Promise<CursorPage<TopUpView>> {
    const after = decodeCursor(cursor);
    const params: unknown[] = [merchantId, mode, limit + 1];
    const where = [`t."merchantId" = $1`, `t.mode = $2`];
    const created = cursorTime('t."createdAt"');
    if (after) {
      params.push(after.t, after.id);
      where.push(
        `(${created}, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    const ids = await this.dataSource.query<{ id: string }[]>(
      `SELECT t.id FROM wallet_top_ups t
        WHERE ${where.join(' AND ')}
        ORDER BY ${created} DESC, t.id DESC
        LIMIT $3`,
      params,
    );
    const rows = ids.length
      ? await this.dataSource.manager
          .getRepository(WalletTopUpEntity)
          .createQueryBuilder('t')
          .whereInIds(ids.map((row) => row.id))
          .getMany()
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.map((row) => byId.get(row.id)!);
    return toCursorPage<WalletTopUpEntity, TopUpView>(
      ordered,
      limit,
      (row): CursorPosition => ({ t: row.createdAt.toISOString(), id: row.id }),
      topUpView,
    );
  }

  // The dashboard polls this after the payment page redirects back. A
  // pending card payment is checked with Paystack, so the screen updates
  // even before (or without) the webhook.
  async get(caller: MerchantCaller, id: string): Promise<TopUpView> {
    let topUp = await this.topUpOf(caller, id);
    if (topUp.status === 'pending' && topUp.method === 'card') {
      try {
        await this.settleCard(topUp, Date.now());
        topUp = await this.topUpOf(caller, id);
      } catch (error) {
        // Paystack unreachable: show it as still pending.
        this.logger.warn(`Couldn't check top-up ${id}: ${String(error)}`);
      }
    }
    return topUpView(topUp);
  }

  // ─── Dedicated account (bank transfers, live only) ────────────────────

  async fundingAccount(
    caller: MerchantCaller,
  ): Promise<FundingAccountView | null> {
    if (caller.mode !== 'live') {
      return null;
    }
    const account = await this.dataSource.manager.findOneBy(
      MerchantFundingAccountEntity,
      { merchantId: caller.merchantId },
    );
    return account ? fundingAccountView(account) : null;
  }

  // Idempotent: returns the existing account if there is one. Serialised
  // per merchant, so two clicks can't open two accounts.
  async createFundingAccount(
    caller: MerchantCaller,
  ): Promise<FundingAccountView> {
    if (caller.mode !== 'live') {
      throw new LiveModeOnlyException(
        'Bank-transfer top-ups are for your live wallet (switch to Live). Reset your test wallet instead.',
      );
    }
    const merchant = await this.fundableMerchant(caller);
    const missing = [
      ...(merchant.contactEmail ? [] : ['contactEmail']),
      ...(merchant.contactPhone ? [] : ['contactPhone']),
    ];
    if (missing.length > 0) {
      throw new ContactDetailsRequiredException(missing);
    }
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `funding-account:${merchant.id}`,
      ]);
      const existing = await manager.findOneBy(MerchantFundingAccountEntity, {
        merchantId: merchant.id,
      });
      if (existing) {
        return fundingAccountView(existing);
      }
      const customer = await this.gateway.createCustomer('live', {
        email: merchant.contactEmail!,
        firstName: merchant.tradingName,
        lastName: 'Wallet',
        phone: merchant.contactPhone!,
      });
      const taken = await manager.findOneBy(MerchantFundingAccountEntity, {
        customerCode: customer.customerCode,
      });
      if (taken) {
        throw new FundingAccountConflictException();
      }
      const dedicated = await this.gateway.createDedicatedAccount(
        'live',
        customer.customerCode,
      );
      const saved = await manager.save(
        manager.create(MerchantFundingAccountEntity, {
          merchantId: merchant.id,
          provider: 'paystack',
          customerCode: customer.customerCode,
          customerId: customer.customerId,
          ...dedicated,
          lastSweptAt: null,
        }),
      );
      return fundingAccountView(saved);
    });
  }

  // ─── Crediting ────────────────────────────────────────────────────────

  // Paystack webhook for a charge that isn't a checkout intent (via the
  // payments router, inside its transaction). True if it's ours.
  async handleWebhook(
    event: PaymentWebhookEvent,
    manager: EntityManager,
  ): Promise<boolean> {
    const reference = event.providerReference;
    if (!reference) {
      return false;
    }
    const topUp = await manager.findOneBy(WalletTopUpEntity, { reference });
    if (topUp?.method === 'card') {
      const charge = await this.gateway.verify(envFor(topUp.mode), reference);
      if (charge?.status === 'success') {
        await this.creditCharge(
          manager,
          topUp.merchantId,
          topUp.mode,
          'card',
          charge,
        );
      }
      return true;
    }
    if (event.channel === DEDICATED_ACCOUNT_CHANNEL && event.customerCode) {
      const account = await manager.findOneBy(MerchantFundingAccountEntity, {
        customerCode: event.customerCode,
      });
      if (!account) {
        return false;
      }
      const charge = await this.gateway.verify('live', reference);
      if (
        charge?.status === 'success' &&
        charge.customerCode === account.customerCode
      ) {
        await this.creditCharge(
          manager,
          account.merchantId,
          'live',
          'bank_transfer',
          charge,
        );
      }
      return true;
    }
    return false;
  }

  // ─── Sweep (worker) ───────────────────────────────────────────────────

  // Catches what webhooks missed: card payments left pending, and transfers
  // into dedicated accounts. Safe to run any time (credits are idempotent).
  async sweep(now = Date.now()): Promise<SweepResult> {
    const result: SweepResult = { credited: 0, failed: 0, abandoned: 0 };
    const pending = await this.dataSource.manager
      .getRepository(WalletTopUpEntity)
      .createQueryBuilder('t')
      .where(`t.status = 'pending' AND t.method = 'card'`)
      .andWhere('t."createdAt" < :settled', {
        settled: new Date(now - CARD_SETTLE_MS),
      })
      .orderBy('t."createdAt"', 'ASC')
      .take(SWEEP_BATCH)
      .getMany();
    for (const topUp of pending) {
      try {
        const outcome = await this.settleCard(topUp, now);
        if (outcome) {
          result[outcome]++;
        }
      } catch (error) {
        this.logger.error(`Top-up ${topUp.id} sweep failed: ${String(error)}`);
      }
    }

    const accounts = await this.dataSource.manager.find(
      MerchantFundingAccountEntity,
    );
    for (const account of accounts) {
      try {
        result.credited += await this.sweepAccount(account, now);
      } catch (error) {
        this.logger.error(
          `Funding account ${account.id} sweep failed: ${String(error)}`,
        );
      }
    }
    return result;
  }

  private async tick(): Promise<void> {
    if (this.sweeping) {
      return;
    }
    this.sweeping = true;
    try {
      const result = await this.sweep();
      if (result.credited || result.failed || result.abandoned) {
        this.logger.log(
          `Top-up sweep: ${result.credited} credited, ${result.failed} failed, ${result.abandoned} abandoned`,
        );
      }
    } catch (error) {
      this.logger.error(`Top-up sweep failed: ${String(error)}`);
    } finally {
      this.sweeping = false;
    }
  }

  // Asks Paystack about one pending card payment and records the answer.
  private async settleCard(
    topUp: WalletTopUpEntity,
    now: number,
  ): Promise<'credited' | 'failed' | 'abandoned' | null> {
    const charge = await this.gateway.verify(
      envFor(topUp.mode),
      topUp.reference,
    );
    if (charge?.status === 'success') {
      const credited = await this.dataSource.transaction((manager) =>
        this.creditCharge(
          manager,
          topUp.merchantId,
          topUp.mode,
          'card',
          charge,
        ),
      );
      return credited ? 'credited' : null;
    }
    const next: TopUpStatus | null =
      charge?.status === 'failed'
        ? 'failed'
        : now - topUp.createdAt.getTime() > CARD_ABANDON_MS
          ? 'abandoned'
          : null;
    if (!next) {
      return null;
    }
    await this.dataSource.manager.update(
      WalletTopUpEntity,
      { id: topUp.id, status: 'pending' },
      { status: next },
    );
    return next;
  }

  private async sweepAccount(
    account: MerchantFundingAccountEntity,
    now: number,
  ): Promise<number> {
    const since = (account.lastSweptAt ?? account.createdAt).getTime();
    const charges = await this.gateway.successfulCharges(
      'live',
      account.customerId,
      new Date(since - TRANSFER_LOOKBACK_MS),
    );
    let credited = 0;
    for (const charge of charges) {
      if (charge.channel !== DEDICATED_ACCOUNT_CHANNEL) {
        continue;
      }
      if (
        await this.dataSource.transaction((manager) =>
          this.creditCharge(
            manager,
            account.merchantId,
            'live',
            'bank_transfer',
            charge,
          ),
        )
      ) {
        credited++;
      }
    }
    await this.dataSource.manager.update(
      MerchantFundingAccountEntity,
      { id: account.id },
      { lastSweptAt: new Date(now) },
    );
    return credited;
  }

  // The one place money from Paystack reaches a wallet. Serialised per
  // reference; a no-op (false) if that charge was already credited.
  private async creditCharge(
    manager: EntityManager,
    merchantId: string,
    mode: ApiKeyMode,
    method: TopUpMethod,
    charge: WalletCharge,
  ): Promise<boolean> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      paystackExternalRef(charge.reference),
    ]);
    let topUp = await manager.findOne(WalletTopUpEntity, {
      where: { reference: charge.reference },
      lock: { mode: 'pessimistic_write' },
    });
    if (topUp && method === 'card' && charge.amountKobo !== topUp.amountKobo) {
      // Never credit a payment that doesn't match what was asked for.
      this.logger.error(
        `Top-up ${topUp.id}: paid ${charge.amountKobo} but asked for ${topUp.amountKobo}; not credited`,
      );
      return false;
    }
    const creditKobo = creditedAmount(
      method,
      charge.amountKobo,
      charge.feeKobo,
    );
    const posted = await this.wallet.creditExternal(manager, {
      merchantId,
      mode,
      type: WalletEntryType.TOP_UP,
      amountKobo: creditKobo,
      description: method === 'card' ? 'Card top-up' : 'Bank transfer top-up',
      externalRef: paystackExternalRef(charge.reference),
      createdByUserId: topUp?.createdByUserId ?? null,
    });
    if (!posted) {
      return false;
    }

    topUp ??= manager.create(WalletTopUpEntity, {
      merchantId,
      mode,
      method,
      reference: charge.reference,
      amountKobo: charge.amountKobo,
      authorizationUrl: null,
      createdByUserId: null,
    });
    topUp.status = 'succeeded';
    topUp.feeKobo = method === 'card' ? charge.feeKobo : 0;
    topUp.creditedKobo = creditKobo;
    topUp.paidAt = charge.paidAt ?? new Date();
    topUp.entryId = posted.entry.id;
    const saved = await manager.save(topUp);

    await this.emitter.emit(manager, {
      merchantId,
      mode,
      type: 'wallet.funded',
      data: { topUp: topUpView(saved), wallet: walletView(posted.wallet) },
    });
    const merchant = await manager.findOneByOrFail(MerchantEntity, {
      id: merchantId,
    });
    await this.notifier.walletFunded(
      merchant,
      saved,
      posted.wallet.balanceKobo,
      manager,
    );
    return true;
  }

  // ─── Guards ───────────────────────────────────────────────────────────

  // Test wallets can be topped up by any open merchant; live wallets only
  // once approved (suspended merchants may still fund a negative balance).
  private async fundableMerchant(
    caller: MerchantCaller,
  ): Promise<MerchantEntity> {
    const merchant = await this.dataSource.manager.findOneByOrFail(
      MerchantEntity,
      { id: caller.merchantId },
    );
    if (
      merchant.status === MerchantStatus.CLOSED ||
      merchant.status === MerchantStatus.REJECTED
    ) {
      throw new MerchantNotEditableException(merchant.status);
    }
    if (
      caller.mode === 'live' &&
      merchant.status !== MerchantStatus.APPROVED &&
      merchant.status !== MerchantStatus.SUSPENDED
    ) {
      throw new MerchantNotApprovedException();
    }
    return merchant;
  }

  private async topUpOf(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    id: string,
  ): Promise<WalletTopUpEntity> {
    const topUp = await this.dataSource.manager.findOneBy(WalletTopUpEntity, {
      id,
      merchantId: caller.merchantId,
      mode: caller.mode,
    });
    if (!topUp) {
      throw new EntityNotFoundException('Top-up', id);
    }
    return topUp;
  }
}
