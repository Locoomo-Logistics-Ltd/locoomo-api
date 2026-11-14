import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireVerifiedEmail } from '../../../common/auth/decorators/account-requirements.decorator';
import { IdempotencyInterceptor } from '../../../common/idempotency/idempotency.interceptor';
import type { CursorPage } from '../../../common/pagination/cursor';
import type { MerchantCaller } from '../application/merchant-state';
import { MerchantShipmentService } from '../application/merchant-shipment.service';
import { ShipmentSimulatorService } from '../application/shipment-simulator.service';
import { ApiKeyScope } from '../domain/api-key';
import { MerchantPermission } from '../domain/merchant-permissions';
import {
  BulkCreateResultView,
  BulkCreateShipmentsDto,
  CreateShipmentDto,
  ListShipmentsQueryDto,
  ShipmentListView,
  ShipmentView,
  SimulateShipmentDto,
  TimelineEntryView,
  UpdateShipmentDto,
} from './dto/shipment.dto';
import {
  CurrentMerchantCaller,
  MerchantApi,
  MerchantGuard,
} from './merchant.guard';

const IDEMPOTENCY_HEADER = ApiHeader({
  name: 'Idempotency-Key',
  required: false,
  description:
    'Recommended on every POST (a UUID). Retrying with the same key and body replays the original response.',
});

const READ = (): MethodDecorator & ClassDecorator =>
  MerchantApi(ApiKeyScope.SHIPMENTS_READ, MerchantPermission.SHIPMENTS_READ);
const WRITE = (): MethodDecorator & ClassDecorator =>
  MerchantApi(ApiKeyScope.SHIPMENTS_WRITE, MerchantPermission.SHIPMENTS_WRITE);

// MERCHANT_API.md §7. A secret key, or a dashboard session (mode from the
// Locoomo-Mode header).
@ApiTags('Shipments')
@ApiBearerAuth('apiKey')
@Controller('merchant/shipments')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class ShipmentsController {
  constructor(private readonly shipments: MerchantShipmentService) {}

  /** Create a shipment. The quoted fee is held on your wallet. */
  @Post()
  @WRITE()
  @UseInterceptors(IdempotencyInterceptor)
  @IDEMPOTENCY_HEADER
  @ApiCreatedResponse({ type: ShipmentView })
  create(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Body() dto: CreateShipmentDto,
  ): Promise<ShipmentView> {
    return this.shipments.create(caller, dto);
  }

  /** Up to 100 shipments; each succeeds or fails on its own. */
  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @WRITE()
  @UseInterceptors(IdempotencyInterceptor)
  @IDEMPOTENCY_HEADER
  @ApiOkResponse({ type: BulkCreateResultView })
  async bulk(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Body() dto: BulkCreateShipmentsDto,
  ): Promise<BulkCreateResultView> {
    return { results: await this.shipments.bulkCreate(caller, dto.items) };
  }

  /** List and sync. With `updatedSince`, oldest change first. */
  @Get()
  @READ()
  @ApiOkResponse({ type: ShipmentListView })
  list(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Query() query: ListShipmentsQueryDto,
  ): Promise<CursorPage<ShipmentView>> {
    return this.shipments.list(caller, query);
  }

  @Get(':id')
  @READ()
  @ApiOkResponse({ type: ShipmentView })
  get(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ShipmentView> {
    return this.shipments.get(caller, id);
  }

  /** Event history, oldest first. */
  @Get(':id/timeline')
  @READ()
  @ApiOkResponse({ type: [TimelineEntryView] })
  timeline(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TimelineEntryView[]> {
    return this.shipments.timeline(caller, id);
  }

  @Patch(':id')
  @WRITE()
  @ApiOkResponse({ type: ShipmentView })
  update(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateShipmentDto,
  ): Promise<ShipmentView> {
    return this.shipments.update(caller, id, dto);
  }

  /** Only before drop-off; the hold is released. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @WRITE()
  @UseInterceptors(IdempotencyInterceptor)
  @IDEMPOTENCY_HEADER
  @ApiOkResponse({ type: ShipmentView })
  cancel(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ShipmentView> {
    return this.shipments.cancel(caller, id);
  }

  /** From received until ready_for_collection: bring it back to you. */
  @Post(':id/return-to-sender')
  @HttpCode(HttpStatus.OK)
  @WRITE()
  @UseInterceptors(IdempotencyInterceptor)
  @IDEMPOTENCY_HEADER
  @ApiOkResponse({ type: ShipmentView })
  returnToSender(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ShipmentView> {
    return this.shipments.returnToSender(caller, id);
  }
}

// MERCHANT_API.md §13: move a test shipment through its lifecycle.
@ApiTags('Sandbox')
@ApiBearerAuth('apiKey')
@Controller('merchant/test/shipments')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class TestShipmentsController {
  constructor(private readonly simulator: ShipmentSimulatorService) {}

  /** Test shipments only. Every intermediate step fires, as in live. */
  @Post(':id/simulate')
  @HttpCode(HttpStatus.OK)
  @WRITE()
  @ApiOkResponse({ type: ShipmentView })
  simulate(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SimulateShipmentDto,
  ): Promise<ShipmentView> {
    return this.simulator.simulate(caller, id, dto);
  }
}
