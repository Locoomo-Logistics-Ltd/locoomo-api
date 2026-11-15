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
import { RequireVerifiedEmail } from '../../../common/auth/decorators/account-requirements.decorator';
import type { UploadSignature } from '../../../common/cloudinary/cloudinary.service';
import { IdempotencyInterceptor } from '../../../common/idempotency/idempotency.interceptor';
import type { CursorPage } from '../../../common/pagination/cursor';
import {
  ClaimView as Claim,
  MerchantClaimsService,
} from '../application/merchant-claims.service';
import type { MerchantCaller } from '../application/merchant-state';
import { ApiKeyScope } from '../domain/api-key';
import { MerchantPermission } from '../domain/merchant-permissions';
import {
  ClaimListView,
  ClaimView,
  DecideTestClaimDto,
  FileClaimDto,
  ListClaimsQueryDto,
} from './dto/claim.dto';
import {
  CurrentMerchantCaller,
  MerchantApi,
  MerchantGuard,
} from './merchant.guard';

// MERCHANT_API.md §15. Claims for lost or damaged parcels.
@ApiTags('Claims')
@ApiBearerAuth('apiKey')
@Controller('merchant/claims')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class ClaimsController {
  constructor(private readonly claims: MerchantClaimsService) {}

  /** File a claim, within 30 days of the shipment's last status change. */
  @Post()
  @MerchantApi(ApiKeyScope.CLAIMS_WRITE, MerchantPermission.SHIPMENTS_WRITE)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiCreatedResponse({ type: ClaimView })
  file(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Body() dto: FileClaimDto,
  ): Promise<Claim> {
    return this.claims.file(caller, dto);
  }

  /** A signed upload for one evidence file (photo or PDF). */
  @Post('uploads')
  @HttpCode(HttpStatus.OK)
  @MerchantApi(ApiKeyScope.CLAIMS_WRITE, MerchantPermission.SHIPMENTS_WRITE)
  uploadSignature(
    @CurrentMerchantCaller() caller: MerchantCaller,
  ): UploadSignature {
    return this.claims.uploadSignature(caller);
  }

  /** Your claims, newest first. */
  @Get()
  @MerchantApi(ApiKeyScope.SHIPMENTS_READ, MerchantPermission.SHIPMENTS_READ)
  @ApiOkResponse({ type: ClaimListView })
  list(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Query() query: ListClaimsQueryDto,
  ): Promise<CursorPage<Claim>> {
    return this.claims.list(caller, query);
  }

  @Get(':id')
  @MerchantApi(ApiKeyScope.SHIPMENTS_READ, MerchantPermission.SHIPMENTS_READ)
  @ApiOkResponse({ type: ClaimView })
  get(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Claim> {
    return this.claims.get(caller, id);
  }
}

// Sandbox: decide your own test claims (MERCHANT_API.md §13).
@ApiTags('Claims')
@ApiBearerAuth('apiKey')
@Controller('merchant/test/claims')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class TestClaimsController {
  constructor(private readonly claims: MerchantClaimsService) {}

  /** Approve (credits the test wallet) or reject a test claim. */
  @Post(':id/decide')
  @HttpCode(HttpStatus.OK)
  @MerchantApi(ApiKeyScope.CLAIMS_WRITE, MerchantPermission.SHIPMENTS_WRITE)
  @ApiOkResponse({ type: ClaimView })
  decide(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideTestClaimDto,
  ): Promise<Claim> {
    return this.claims.decideTest(caller, id, dto);
  }
}
