import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { RequireVerifiedEmail } from '../../../common/auth/decorators/account-requirements.decorator';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { SkipResponseEnvelope } from '../../../common/decorators/skip-response-envelope.decorator';
import { IdempotencyInterceptor } from '../../../common/idempotency/idempotency.interceptor';
import type { CursorPage } from '../../../common/pagination/cursor';
import {
  HubManifestView,
  HubScanResult,
  ManifestReceipt,
  ManifestService,
  ManifestView as Manifest,
} from '../application/manifest.service';
import type { MerchantCaller } from '../application/merchant-state';
import { ApiKeyScope } from '../domain/api-key';
import { MerchantPermission } from '../domain/merchant-permissions';
import {
  AddManifestShipmentsDto,
  CreateManifestDto,
  HubScanDto,
  ListManifestsQueryDto,
  ManifestListView,
  ManifestReceiptView,
  ManifestView,
  SimulateManifestReceiptDto,
} from './dto/manifest.dto';
import {
  CurrentMerchantCaller,
  MerchantApi,
  MerchantGuard,
} from './merchant.guard';

const WRITE = () =>
  MerchantApi(ApiKeyScope.MANIFESTS_WRITE, MerchantPermission.SHIPMENTS_WRITE);
const READ = () =>
  MerchantApi(ApiKeyScope.SHIPMENTS_READ, MerchantPermission.SHIPMENTS_READ);

// MERCHANT_API.md §10. Bulk drop-off at a hub.
@ApiTags('Manifests')
@ApiBearerAuth('apiKey')
@Controller('merchant/manifests')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class ManifestsController {
  constructor(private readonly manifests: ManifestService) {}

  @Post()
  @WRITE()
  @UseInterceptors(IdempotencyInterceptor)
  @ApiCreatedResponse({ type: ManifestView })
  create(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Body() dto: CreateManifestDto,
  ): Promise<Manifest> {
    return this.manifests.create(caller, dto);
  }

  @Post(':id/shipments')
  @HttpCode(HttpStatus.OK)
  @WRITE()
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOkResponse({ type: ManifestView })
  add(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddManifestShipmentsDto,
  ): Promise<Manifest> {
    return this.manifests.addShipments(caller, id, dto.shipmentIds);
  }

  /** The truck has left: nothing more can be added. */
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @WRITE()
  @ApiOkResponse({ type: ManifestView })
  close(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Manifest> {
    return this.manifests.close(caller, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @WRITE()
  @ApiOkResponse({ type: ManifestView })
  cancel(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Manifest> {
    return this.manifests.cancel(caller, id);
  }

  @Get()
  @READ()
  @ApiOkResponse({ type: ManifestListView })
  list(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Query() query: ListManifestsQueryDto,
  ): Promise<CursorPage<Manifest>> {
    return this.manifests.list(caller, query);
  }

  @Get(':id')
  @READ()
  @ApiOkResponse({ type: ManifestView })
  get(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Manifest> {
    return this.manifests.get(caller, id);
  }

  /** PDF for the driver: reference + QR, hub, every parcel. */
  @Get(':id/document')
  @READ()
  @SkipResponseEnvelope()
  @ApiProduces('application/pdf')
  async document(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const { pdf, filename } = await this.manifests.document(caller, id);
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="${filename}"`,
      length: pdf.length,
    });
  }
}

// Sandbox: the hub checks a test manifest in.
@ApiTags('Manifests')
@ApiBearerAuth('apiKey')
@Controller('merchant/test/manifests')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class TestManifestsController {
  constructor(private readonly manifests: ManifestService) {}

  @Post(':id/receive')
  @HttpCode(HttpStatus.OK)
  @WRITE()
  @ApiOkResponse({ type: ManifestReceiptView })
  receive(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SimulateManifestReceiptDto,
  ): Promise<ManifestReceipt> {
    return this.manifests.simulateReceive(caller, id, dto.missingShipmentIds);
  }
}

// Node app at a hub (LOGISTICS_API.md §5.11): manifests expected, the
// check-in scan, and finishing a truck.
@Controller('handoffs')
export class HubManifestsController {
  constructor(private readonly manifests: ManifestService) {}

  @Roles(UserRole.NODE_OPERATOR, UserRole.NODE_STAFF)
  @Get('manifests')
  expected(@CurrentUser() user: AuthenticatedUser): Promise<HubManifestView[]> {
    return this.manifests.expectedAtMyHubs(user.id);
  }

  @Roles(UserRole.NODE_OPERATOR, UserRole.NODE_STAFF)
  @Get('manifests/:reference')
  get(
    @Param('reference') reference: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<HubManifestView> {
    return this.manifests.forHub(user.id, reference);
  }

  @Roles(UserRole.NODE_OPERATOR, UserRole.NODE_STAFF)
  @Post('manifests/:reference/complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @Param('reference') reference: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ManifestReceipt> {
    return this.manifests.completeAtHub(user.id, reference);
  }

  // Scanners fire fast: a generous limit.
  @Roles(UserRole.NODE_OPERATOR, UserRole.NODE_STAFF)
  @Throttle({ default: { limit: 600, ttl: seconds(60) } })
  @Post('hub-intake')
  @HttpCode(HttpStatus.OK)
  scan(
    @Body() dto: HubScanDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<HubScanResult> {
    return this.manifests.scan(user.id, dto);
  }
}
