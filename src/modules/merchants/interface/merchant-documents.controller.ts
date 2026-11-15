import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import { RequireVerifiedEmail } from '../../../common/auth/decorators/account-requirements.decorator';
import { RequireAdminPermission } from '../../../common/auth/decorators/require-admin-permission.decorator';
import { SkipResponseEnvelope } from '../../../common/decorators/skip-response-envelope.decorator';
import {
  MerchantDocumentsService,
  RenderedDocument,
} from '../application/merchant-documents.service';
import type { MerchantCaller } from '../application/merchant-state';
import { ApiKeyScope } from '../domain/api-key';
import { MerchantPermission } from '../domain/merchant-permissions';
import {
  AdminStatementQueryDto,
  StatementFormatQueryDto,
} from './dto/merchant-documents.dto';
import {
  CurrentMerchantCaller,
  MerchantApi,
  MerchantGuard,
} from './merchant.guard';

function download(doc: RenderedDocument): StreamableFile {
  return new StreamableFile(doc.body, {
    type: doc.contentType,
    disposition: `attachment; filename="${doc.filename}"`,
    length: doc.body.length,
  });
}

// MERCHANT_API.md §14.3. Monthly wallet statement (either mode) and tax
// invoice (live, finished months). Months are Lagos calendar months.
@ApiTags('Wallet')
@ApiBearerAuth('apiKey')
@Controller('merchant')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class MerchantDocumentsController {
  constructor(private readonly documents: MerchantDocumentsService) {}

  /** Opening balance, every wallet line in the month, closing balance. */
  @Get('statements/:month')
  @MerchantApi(ApiKeyScope.WALLET_READ, MerchantPermission.WALLET_MANAGE)
  @SkipResponseEnvelope()
  @ApiProduces('application/pdf', 'text/csv')
  async statement(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('month') month: string,
    @Query() query: StatementFormatQueryDto,
  ): Promise<StreamableFile> {
    return download(
      await this.documents.statement(
        caller.merchantId,
        caller.mode,
        month,
        query.format,
      ),
    );
  }

  /** Tax invoice for the shipping charged in a finished month (live). */
  @Get('invoices/:month')
  @MerchantApi(ApiKeyScope.WALLET_READ, MerchantPermission.WALLET_MANAGE)
  @SkipResponseEnvelope()
  @ApiProduces('application/pdf', 'text/csv')
  async invoice(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('month') month: string,
    @Query() query: StatementFormatQueryDto,
  ): Promise<StreamableFile> {
    return download(
      await this.documents.invoice(
        caller.merchantId,
        caller.mode,
        month,
        query.format,
      ),
    );
  }
}

// Admin app: the same documents for any merchant (finance, ops, support).
@Controller('admin/merchants/:id')
export class AdminMerchantDocumentsController {
  constructor(private readonly documents: MerchantDocumentsService) {}

  @Get('statements/:month')
  @RequireAdminPermission(
    AdminPermission.FINANCE,
    AdminPermission.OPS,
    AdminPermission.SUPPORT,
  )
  @SkipResponseEnvelope()
  async statement(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('month') month: string,
    @Query() query: AdminStatementQueryDto,
  ): Promise<StreamableFile> {
    return download(
      await this.documents.statement(id, query.mode, month, query.format),
    );
  }

  @Get('invoices/:month')
  @RequireAdminPermission(
    AdminPermission.FINANCE,
    AdminPermission.OPS,
    AdminPermission.SUPPORT,
  )
  @SkipResponseEnvelope()
  async invoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('month') month: string,
    @Query() query: StatementFormatQueryDto,
  ): Promise<StreamableFile> {
    return download(
      await this.documents.invoice(id, 'live', month, query.format),
    );
  }
}
