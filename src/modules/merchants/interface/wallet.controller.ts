import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RequireVerifiedEmail } from '../../../common/auth/decorators/account-requirements.decorator';
import { IdempotencyInterceptor } from '../../../common/idempotency/idempotency.interceptor';
import type { CursorPage } from '../../../common/pagination/cursor';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import type { MerchantCaller } from '../application/merchant-state';
import {
  MerchantDiscount,
  MerchantPricingService,
} from '../application/merchant-pricing.service';
import {
  FundingAccountView as FundingAccount,
  TopUpView as TopUp,
  WalletTopUpService,
} from '../application/wallet-top-up.service';
import {
  FundingAccountView,
  StartCardTopUpDto,
  StartedTopUpView,
  TopUpListView,
  TopUpView,
} from './dto/wallet-top-up.dto';
import {
  WalletEntryView as WalletEntry,
  WalletHoldView as WalletHold,
  WalletService,
  WalletView as Wallet,
  walletView,
} from '../application/wallet.service';
import { ApiKeyScope } from '../domain/api-key';
import { TestModeOnlyException } from '../domain/exceptions/merchant.exceptions';
import { MerchantPermission } from '../domain/merchant-permissions';
import {
  ListWalletEntriesQueryDto,
  ListWalletHoldsQueryDto,
  WalletSettingsDto,
  MerchantDiscountView,
  WalletEntryListView,
  WalletHoldListView,
  WalletView,
} from './dto/wallet.dto';
import {
  CurrentMerchantCaller,
  MerchantApi,
  MerchantGuard,
  MerchantSessionApi,
} from './merchant.guard';

// MERCHANT_API.md §14. A key with `wallet:read`, or a dashboard session
// (mode from Locoomo-Mode). Any member sees the balance (they ship against
// it); the statement lines need `wallet.manage`.
@ApiTags('Wallet')
@ApiBearerAuth('apiKey')
@Controller('merchant/wallet')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly topUps: WalletTopUpService,
  ) {}

  /** Balance, held and available. */
  @Get()
  @MerchantApi(ApiKeyScope.WALLET_READ, MerchantPermission.SHIPMENTS_READ)
  @ApiOkResponse({ type: WalletView })
  get(@CurrentMerchantCaller() caller: MerchantCaller): Promise<Wallet> {
    return this.wallet.summary(caller.merchantId, caller.mode);
  }

  /** Ledger lines, newest first. */
  @Get('entries')
  @MerchantApi(ApiKeyScope.WALLET_READ, MerchantPermission.WALLET_MANAGE)
  @ApiOkResponse({ type: WalletEntryListView })
  entries(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Query() query: ListWalletEntriesQueryDto,
  ): Promise<CursorPage<WalletEntry>> {
    return this.wallet.entries(caller.merchantId, caller.mode, query);
  }

  /** Fees set aside for shipments, newest first. */
  @Get('holds')
  @MerchantApi(ApiKeyScope.WALLET_READ, MerchantPermission.WALLET_MANAGE)
  @ApiOkResponse({ type: WalletHoldListView })
  holds(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Query() query: ListWalletHoldsQueryDto,
  ): Promise<CursorPage<WalletHold>> {
    return this.wallet.holds(
      caller.merchantId,
      caller.mode,
      query.status,
      query.limit,
      query.cursor,
    );
  }

  /** Card top-up: returns Paystack's payment page. Dashboard only. */
  @Post('top-ups')
  @MerchantSessionApi(MerchantPermission.WALLET_MANAGE)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiCreatedResponse({ type: StartedTopUpView })
  startTopUp(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Body() dto: StartCardTopUpDto,
  ): Promise<{ topUp: TopUp; authorizationUrl: string }> {
    return this.topUps.startCardTopUp(caller, dto.amountKobo);
  }

  /** Card payments and bank transfers, newest first. */
  @Get('top-ups')
  @MerchantApi(ApiKeyScope.WALLET_READ, MerchantPermission.WALLET_MANAGE)
  @ApiOkResponse({ type: TopUpListView })
  listTopUps(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Query() query: CursorQueryDto,
  ): Promise<CursorPage<TopUp>> {
    return this.topUps.list(
      caller.merchantId,
      caller.mode,
      query.limit,
      query.cursor,
    );
  }

  /** One top-up. A pending card payment is checked with Paystack first. */
  @Get('top-ups/:id')
  @MerchantApi(ApiKeyScope.WALLET_READ, MerchantPermission.WALLET_MANAGE)
  @ApiOkResponse({ type: TopUpView })
  getTopUp(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TopUp> {
    return this.topUps.get(caller, id);
  }

  /** The low-balance alert line (dashboard only). */
  @Patch('settings')
  @MerchantSessionApi(MerchantPermission.WALLET_MANAGE)
  @ApiOkResponse({ type: WalletView })
  settings(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Body() dto: WalletSettingsDto,
  ): Promise<Wallet> {
    return this.wallet.setLowBalanceThreshold(
      caller.merchantId,
      caller.mode,
      dto.lowBalanceThresholdKobo,
    );
  }
  /** The live wallet's bank-transfer account number, or null. */
  @Get('funding-account')
  @MerchantApi(ApiKeyScope.WALLET_READ, MerchantPermission.SHIPMENTS_READ)
  @ApiOkResponse({ type: FundingAccountView })
  fundingAccount(
    @CurrentMerchantCaller() caller: MerchantCaller,
  ): Promise<FundingAccount | null> {
    return this.topUps.fundingAccount(caller);
  }

  /** Opens the live wallet's bank-transfer account (idempotent). */
  @Post('funding-account')
  @HttpCode(HttpStatus.OK)
  @MerchantSessionApi(MerchantPermission.WALLET_MANAGE)
  @ApiOkResponse({ type: FundingAccountView })
  createFundingAccount(
    @CurrentMerchantCaller() caller: MerchantCaller,
  ): Promise<FundingAccount> {
    return this.topUps.createFundingAccount(caller);
  }
}

// Sandbox only (MERCHANT_API.md §13).
@ApiTags('Sandbox')
@ApiBearerAuth('apiKey')
@Controller('merchant/test/wallet')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class TestWalletController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly wallet: WalletService,
  ) {}

  /** Puts the test wallet's balance back to ₦1,000,000. Holds stay. */
  @Post('reset')
  @HttpCode(HttpStatus.OK)
  @MerchantApi(ApiKeyScope.SHIPMENTS_WRITE, MerchantPermission.SHIPMENTS_WRITE)
  @ApiOkResponse({ type: WalletView })
  async reset(
    @CurrentMerchantCaller() caller: MerchantCaller,
  ): Promise<Wallet> {
    if (caller.mode !== 'test') {
      throw new TestModeOnlyException(
        'Only the test wallet can be reset (use a test key or Locoomo-Mode: test)',
      );
    }
    const wallet = await this.dataSource.transaction((manager) =>
      this.wallet.resetTestWallet(manager, caller.merchantId, caller.userId),
    );
    return walletView(wallet);
  }
}

// The merchant's volume discount this month (MERCHANT_API.md §14).
@ApiTags('Wallet')
@ApiBearerAuth('apiKey')
@Controller('merchant/pricing')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class MerchantPricingController {
  constructor(private readonly pricing: MerchantPricingService) {}

  @Get()
  @MerchantApi(ApiKeyScope.SHIPMENTS_READ, MerchantPermission.SHIPMENTS_READ)
  @ApiOkResponse({ type: MerchantDiscountView })
  get(
    @CurrentMerchantCaller() caller: MerchantCaller,
  ): Promise<MerchantDiscount> {
    return this.pricing.discountFor(caller.merchantId, caller.mode);
  }
}
