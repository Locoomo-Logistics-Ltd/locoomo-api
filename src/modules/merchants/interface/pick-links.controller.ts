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
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Request } from 'express';
import { auditContextFrom } from '../../../common/audit/audit.service';
import { RequireVerifiedEmail } from '../../../common/auth/decorators/account-requirements.decorator';
import { Public } from '../../../common/auth/decorators/public.decorator';
import { IdempotencyInterceptor } from '../../../common/idempotency/idempotency.interceptor';
import type { CursorPage } from '../../../common/pagination/cursor';
import type { MerchantCaller } from '../application/merchant-state';
import {
  PickLinkService,
  PickLinkView,
  PickNode,
  PublicPickLink,
} from '../application/pick-link.service';
import { ApiKeyScope } from '../domain/api-key';
import { MerchantPermission } from '../domain/merchant-permissions';
import {
  CurrentMerchantCaller,
  MerchantApi,
  MerchantGuard,
} from './merchant.guard';

export class CreatePickLinkDto {
  /**
   * A POST /merchant/shipments body without `destinationNodeId`: the buyer
   * picks it. Validated now, exactly like a shipment.
   */
  @IsObject()
  shipment!: Record<string, unknown>;

  /** Don't show delivery prices to the buyer. Default false. */
  @IsOptional()
  @IsBoolean()
  hidePrices?: boolean;
}

export class ListPickLinksQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @IsOptional()
  @IsString()
  cursor?: string;
}

// MERCHANT_API.md §7.6. A link the merchant shares so the buyer picks
// their own Node; the shipment is created when they do.
@ApiTags('Pick links')
@ApiBearerAuth('apiKey')
@Controller('merchant/pick-links')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class PickLinksController {
  constructor(private readonly links: PickLinkService) {}

  /** Create a pick link: the buyer picks their Node, then the shipment is created. */
  @Post()
  @MerchantApi(ApiKeyScope.SHIPMENTS_WRITE, MerchantPermission.SHIPMENTS_WRITE)
  @UseInterceptors(IdempotencyInterceptor)
  create(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Body() dto: CreatePickLinkDto,
  ): Promise<PickLinkView> {
    return this.links.create(caller, dto);
  }

  /** Your pick links, newest first. */
  @Get()
  @MerchantApi(ApiKeyScope.SHIPMENTS_READ, MerchantPermission.SHIPMENTS_READ)
  list(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Query() query: ListPickLinksQueryDto,
  ): Promise<CursorPage<PickLinkView>> {
    return this.links.list(caller, query);
  }

  /** One pick link, with its share URL and the shipment once picked. */
  @Get(':id')
  @MerchantApi(ApiKeyScope.SHIPMENTS_READ, MerchantPermission.SHIPMENTS_READ)
  get(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PickLinkView> {
    return this.links.get(caller, id);
  }

  /** Cancel an open pick link. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @MerchantApi(ApiKeyScope.SHIPMENTS_WRITE, MerchantPermission.SHIPMENTS_WRITE)
  cancel(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PickLinkView> {
    return this.links.cancel(caller, id);
  }
}

export class PickTokenParam {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{20,64}$/)
  token!: string;
}

export class PickNodesQueryDto {
  /** "lat,lng" of the buyer (from the browser) to sort by distance. */
  @IsOptional()
  @Matches(/^-?\d{1,2}(\.\d+)?,\s*-?\d{1,3}(\.\d+)?$/)
  near?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}

export class PickNodeDto {
  @IsUUID()
  destinationNodeId!: string;
}

// The buyer's page (no login: the token is the credential).
@ApiTags('Pick links')
@Controller('pick')
export class PublicPickController {
  constructor(private readonly links: PickLinkService) {}

  @Public()
  @Get(':token')
  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  view(@Param() params: PickTokenParam): Promise<PublicPickLink> {
    return this.links.publicView(params.token);
  }

  @Public()
  @Get(':token/nodes')
  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  nodes(
    @Param() params: PickTokenParam,
    @Query() query: PickNodesQueryDto,
  ): Promise<PickNode[]> {
    return this.links.nodes(params.token, query);
  }

  @Public()
  @Post(':token')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  pick(
    @Param() params: PickTokenParam,
    @Body() dto: PickNodeDto,
    @Req() request: Request,
  ): Promise<{ trackingCode: string; nodeName: string | null }> {
    return this.links.pick(
      params.token,
      dto.destinationNodeId,
      auditContextFrom(request),
    );
  }
}
