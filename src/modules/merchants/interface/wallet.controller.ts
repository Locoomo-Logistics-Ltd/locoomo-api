import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RequireVerifiedEmail } from '../../../common/auth/decorators/account-requirements.decorator';
import type { CursorPage } from '../../../common/pagination/cursor';
import type { MerchantCaller } from '../application/merchant-state';
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
  WalletEntryListView,
  WalletHoldListView,
  WalletView,
} from './dto/wallet.dto';
import {
  CurrentMerchantCaller,
  MerchantApi,
  MerchantGuard,
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
  constructor(private readonly wallet: WalletService) {}

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
