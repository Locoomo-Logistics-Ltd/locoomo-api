import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';
import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { RequireVerifiedEmail } from '../../../common/auth/decorators/account-requirements.decorator';
import { Public } from '../../../common/auth/decorators/public.decorator';
import { SkipResponseEnvelope } from '../../../common/decorators/skip-response-envelope.decorator';
import {
  ExportLink,
  MerchantReportsService,
  ReportSummary,
} from '../application/merchant-reports.service';
import type { MerchantCaller } from '../application/merchant-state';
import { ApiKeyScope } from '../domain/api-key';
import { MerchantPermission } from '../domain/merchant-permissions';
import {
  CurrentMerchantCaller,
  MerchantApi,
  MerchantGuard,
} from './merchant.guard';

export class ReportRangeQueryDto {
  /** Default: 30 days before `to`. At most 93 days. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Default: now. */
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class CreateExportDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;
}

export class ExportLinkView {
  /** GET it (on the API host) within 15 minutes; no auth header needed. */
  downloadPath!: string;
  expiresAt!: string;
}

// MERCHANT_API.md §14.4. KPIs and CSV exports for a date range.
@ApiTags('Reports')
@ApiBearerAuth('apiKey')
@Controller('merchant')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class ReportsController {
  constructor(private readonly reports: MerchantReportsService) {}

  @Get('reports/summary')
  @MerchantApi(ApiKeyScope.SHIPMENTS_READ, MerchantPermission.SHIPMENTS_READ)
  summary(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Query() query: ReportRangeQueryDto,
  ): Promise<ReportSummary> {
    return this.reports.summary(caller, query);
  }

  /** Every shipment created in the range, as CSV, via a 15-minute link. */
  @Post('exports/shipments')
  @HttpCode(HttpStatus.OK)
  @MerchantApi(ApiKeyScope.SHIPMENTS_READ, MerchantPermission.SHIPMENTS_READ)
  @ApiOkResponse({ type: ExportLinkView })
  exportShipments(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Body() dto: CreateExportDto,
  ): Promise<ExportLink> {
    return this.reports.createExport(caller, { type: 'shipments', ...dto });
  }

  /** Every wallet line in the range, as CSV, via a 15-minute link. */
  @Post('exports/wallet-entries')
  @HttpCode(HttpStatus.OK)
  @MerchantApi(ApiKeyScope.WALLET_READ, MerchantPermission.WALLET_MANAGE)
  @ApiOkResponse({ type: ExportLinkView })
  exportWallet(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Body() dto: CreateExportDto,
  ): Promise<ExportLink> {
    return this.reports.createExport(caller, {
      type: 'wallet_entries',
      ...dto,
    });
  }
}

export class ExportDownloadQueryDto {
  @IsString()
  @MaxLength(2000)
  token!: string;
}

// The signed link itself: no session or key, the token is the credential
// (a browser can open it directly).
@ApiTags('Reports')
@Controller('merchant/exports')
export class ExportDownloadController {
  constructor(private readonly reports: MerchantReportsService) {}

  @Public()
  @Get('download')
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @SkipResponseEnvelope()
  async download(
    @Query() query: ExportDownloadQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.reports.streamExport(query.token, res);
  }
}
