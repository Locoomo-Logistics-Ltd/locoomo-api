import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RequireVerifiedEmail } from '../../../common/auth/decorators/account-requirements.decorator';
import { SkipResponseEnvelope } from '../../../common/decorators/skip-response-envelope.decorator';
import type { CursorPage } from '../../../common/pagination/cursor';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import { createValidationException } from '../../../common/pipes/validation-exception-factory';
import type { MerchantCaller } from '../application/merchant-state';
import {
  ImportRowView,
  ImportView,
  ShipmentImportService,
} from '../application/shipment-import.service';
import { ApiKeyScope } from '../domain/api-key';
import { MerchantPermission } from '../domain/merchant-permissions';
import { CSV_TEMPLATE, MAX_CSV_BYTES } from '../domain/shipment-import';
import {
  ImportItemsDto,
  ImportRowsQueryDto,
  ShipmentImportListView,
  ShipmentImportRowListView,
  ShipmentImportView,
} from './dto/shipment-import.dto';
import {
  CurrentMerchantCaller,
  MerchantApi,
  MerchantGuard,
} from './merchant.guard';

interface UploadedCsv {
  buffer: Buffer;
  originalname: string;
}

const READ = (): MethodDecorator & ClassDecorator =>
  MerchantApi(ApiKeyScope.SHIPMENTS_READ, MerchantPermission.SHIPMENTS_READ);
const WRITE = (): MethodDecorator & ClassDecorator =>
  MerchantApi(ApiKeyScope.SHIPMENTS_WRITE, MerchantPermission.SHIPMENTS_WRITE);

// MERCHANT_API.md §7.3: up to 10,000 shipments, created in the background.
@ApiTags('Shipment imports')
@ApiBearerAuth('apiKey')
@Controller('merchant/shipment-imports')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class ShipmentImportsController {
  constructor(private readonly imports: ShipmentImportService) {}

  /**
   * Start an import: a JSON body `{ "items": [...] }` (same shape as
   * POST /shipments; the 1 MB body limit applies) or a CSV file in the
   * multipart field `file` (up to 5 MB). Rows are created in the background.
   */
  @Post()
  @WRITE()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_CSV_BYTES, files: 1 } }),
  )
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiCreatedResponse({ type: ShipmentImportView })
  async create(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Body() body: Record<string, unknown>,
    @UploadedFile() file?: UploadedCsv,
  ): Promise<ImportView> {
    if (file) {
      return this.imports.fromCsv(
        caller,
        file.buffer.toString('utf8'),
        file.originalname,
      );
    }
    const dto = plainToInstance(ImportItemsDto, body ?? {});
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
      throw createValidationException(errors);
    }
    return this.imports.fromJson(caller, dto.items);
  }

  @Get()
  @READ()
  @ApiOkResponse({ type: ShipmentImportListView })
  list(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Query() query: CursorQueryDto,
  ): Promise<CursorPage<ImportView>> {
    return this.imports.list(caller, query.limit, query.cursor);
  }

  /** The CSV columns, with one example row. */
  @Get('template.csv')
  @READ()
  @SkipResponseEnvelope()
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="locoomo-shipments.csv"')
  @ApiProduces('text/csv')
  template(): string {
    return CSV_TEMPLATE;
  }

  @Get(':id')
  @READ()
  @ApiOkResponse({ type: ShipmentImportView })
  get(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ImportView> {
    return this.imports.get(caller, id);
  }

  /** Rows in file order, with each one's shipment or error. */
  @Get(':id/rows')
  @READ()
  @ApiOkResponse({ type: ShipmentImportRowListView })
  rows(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ImportRowsQueryDto,
  ): Promise<CursorPage<ImportRowView>> {
    return this.imports.rows(
      caller,
      id,
      query.status,
      query.limit,
      query.cursor,
    );
  }
}
