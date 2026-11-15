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
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { RequireVerifiedEmail } from '../../../common/auth/decorators/account-requirements.decorator';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { IdempotencyInterceptor } from '../../../common/idempotency/idempotency.interceptor';
import type { CursorPage } from '../../../common/pagination/cursor';
import type { MerchantCaller } from '../application/merchant-state';
import {
  NodeReturnBatchView,
  ReturnBatchService,
  ReturnBatchView as Batch,
  ReturnItemView as ReturnItem,
} from '../application/return-batch.service';
import { ApiKeyScope } from '../domain/api-key';
import { MerchantPermission } from '../domain/merchant-permissions';
import {
  CollectReturnBatchDto,
  CreateReturnBatchDto,
  ListReturnBatchesQueryDto,
  ListReturnsQueryDto,
  ReturnBatchListView,
  ReturnBatchView,
  ReturnItemListView,
} from './dto/return-batch.dto';
import {
  CurrentMerchantCaller,
  MerchantApi,
  MerchantGuard,
} from './merchant.guard';

// The batch carries its collection code, so reading it needs write access.
const BATCHES = () =>
  MerchantApi(ApiKeyScope.SHIPMENTS_WRITE, MerchantPermission.RETURNS_COLLECT);

// MERCHANT_API.md §11.3. Returns waiting for you, and batches that hand
// them all back at a Node on one code.
@ApiTags('Returns')
@ApiBearerAuth('apiKey')
@Controller('merchant')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class ReturnBatchesController {
  constructor(private readonly batches: ReturnBatchService) {}

  /** Returns waiting at a Node (`ready`, oldest first) or on the way (`incoming`). */
  @Get('returns')
  @MerchantApi(ApiKeyScope.SHIPMENTS_READ, MerchantPermission.SHIPMENTS_READ)
  @ApiOkResponse({ type: ReturnItemListView })
  returns(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Query() query: ListReturnsQueryDto,
  ): Promise<CursorPage<ReturnItem>> {
    return this.batches.returns(caller, query);
  }

  /** One collection code for returns waiting at one Node. */
  @Post('return-batches')
  @BATCHES()
  @UseInterceptors(IdempotencyInterceptor)
  @ApiCreatedResponse({ type: ReturnBatchView })
  create(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Body() dto: CreateReturnBatchDto,
  ): Promise<Batch> {
    return this.batches.create(caller, dto);
  }

  @Get('return-batches')
  @BATCHES()
  @ApiOkResponse({ type: ReturnBatchListView })
  list(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Query() query: ListReturnBatchesQueryDto,
  ): Promise<CursorPage<Batch>> {
    return this.batches.list(caller, query);
  }

  @Get('return-batches/:id')
  @BATCHES()
  @ApiOkResponse({ type: ReturnBatchView })
  get(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Batch> {
    return this.batches.get(caller, id);
  }

  /** A new code; the old one stops working. */
  @Post('return-batches/:id/code')
  @HttpCode(HttpStatus.OK)
  @BATCHES()
  @ApiOkResponse({ type: ReturnBatchView })
  reissueCode(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Batch> {
    return this.batches.reissueCode(caller, id);
  }

  /** The returns go back to waiting, each on its own code. */
  @Post('return-batches/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @BATCHES()
  @ApiOkResponse({ type: ReturnBatchView })
  cancel(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Batch> {
    return this.batches.cancel(caller, id);
  }
}

// Sandbox: the Node hands a test batch over.
@ApiTags('Returns')
@ApiBearerAuth('apiKey')
@Controller('merchant/test/return-batches')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class TestReturnBatchesController {
  constructor(private readonly batches: ReturnBatchService) {}

  @Post(':id/collect')
  @HttpCode(HttpStatus.OK)
  @MerchantApi(ApiKeyScope.SHIPMENTS_WRITE, MerchantPermission.SHIPMENTS_WRITE)
  @ApiOkResponse({ type: ReturnBatchView })
  collect(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Batch> {
    return this.batches.simulateCollect(caller, id);
  }
}

// Node app (LOGISTICS_API.md §5.9a): a merchant's batch reference loads
// the batch; its code hands every waiting parcel back.
@Controller('handoffs/return-batches')
export class NodeReturnBatchesController {
  constructor(private readonly batches: ReturnBatchService) {}

  /** Open batches expected at your Nodes. */
  @Roles(UserRole.NODE_OPERATOR, UserRole.NODE_STAFF)
  @Get()
  open(@CurrentUser() user: AuthenticatedUser): Promise<NodeReturnBatchView[]> {
    return this.batches.openAtMyNodes(user.id);
  }

  @Roles(UserRole.NODE_OPERATOR, UserRole.NODE_STAFF)
  @Get(':reference')
  get(
    @Param('reference') reference: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NodeReturnBatchView> {
    return this.batches.forNode(user.id, reference);
  }

  @Roles(UserRole.NODE_OPERATOR, UserRole.NODE_STAFF)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post(':reference/collect')
  @HttpCode(HttpStatus.OK)
  collect(
    @Param('reference') reference: string,
    @Body() dto: CollectReturnBatchDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NodeReturnBatchView> {
    return this.batches.collect(user.id, reference, dto);
  }
}
