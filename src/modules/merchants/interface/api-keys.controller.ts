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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import type { RequestWithUser } from '../../../common/auth/auth.guard';
import { RequireVerifiedEmail } from '../../../common/auth/decorators/account-requirements.decorator';
import { AllowApiKey } from '../../../common/auth/decorators/allow-api-key.decorator';
import { UnauthenticatedException } from '../../../common/exceptions';
import type { CursorPage } from '../../../common/pagination/cursor';
import {
  ApiKeyService,
  ApiKeyView,
  CreatedApiKey,
} from '../application/api-key.service';
import {
  ApiRequestLogService,
  ApiRequestView,
} from '../application/api-request-log.service';
import type { MerchantActor } from '../application/merchant-state';
import { MerchantPermission } from '../domain/merchant-permissions';
import {
  ApiKeyModeQueryDto,
  CreateApiKeyDto,
  ListApiRequestsQueryDto,
  RevokeAllApiKeysDto,
  RollApiKeyDto,
  UpdateApiKeyDto,
} from './dto/api-key.dto';
import {
  CurrentMerchantActor,
  MerchantAccess,
  MerchantGuard,
} from './merchant.guard';

// Developers › API keys and API logs (dashboard, cookie session only).
@ApiExcludeController()
@Controller('merchant')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class ApiKeysController {
  constructor(
    private readonly keys: ApiKeyService,
    private readonly logs: ApiRequestLogService,
  ) {}

  @Get('api-keys')
  @MerchantAccess(MerchantPermission.DEVELOPERS_MANAGE)
  list(
    @CurrentMerchantActor() actor: MerchantActor,
    @Query() query: ApiKeyModeQueryDto,
  ): Promise<ApiKeyView[]> {
    return this.keys.list(actor.merchantId, query.mode);
  }

  @Post('api-keys')
  @MerchantAccess(MerchantPermission.DEVELOPERS_MANAGE)
  create(
    @CurrentMerchantActor() actor: MerchantActor,
    @Body() dto: CreateApiKeyDto,
  ): Promise<CreatedApiKey> {
    return this.keys.create(actor, dto);
  }

  // Declared before api-keys/:id routes.
  @Post('api-keys/revoke-all')
  @HttpCode(HttpStatus.OK)
  @MerchantAccess(MerchantPermission.DEVELOPERS_MANAGE)
  revokeAll(
    @CurrentMerchantActor() actor: MerchantActor,
    @Body() dto: RevokeAllApiKeysDto,
  ): Promise<{ revoked: number }> {
    return this.keys.revokeAll(actor, dto.mode);
  }

  @Patch('api-keys/:id')
  @MerchantAccess(MerchantPermission.DEVELOPERS_MANAGE)
  update(
    @CurrentMerchantActor() actor: MerchantActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateApiKeyDto,
  ): Promise<ApiKeyView> {
    return this.keys.update(actor, id, dto);
  }

  @Post('api-keys/:id/roll')
  @MerchantAccess(MerchantPermission.DEVELOPERS_MANAGE)
  roll(
    @CurrentMerchantActor() actor: MerchantActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RollApiKeyDto,
  ): Promise<CreatedApiKey> {
    return this.keys.roll(actor, id, dto.expireOldIn);
  }

  @Post('api-keys/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @MerchantAccess(MerchantPermission.DEVELOPERS_MANAGE)
  revoke(
    @CurrentMerchantActor() actor: MerchantActor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApiKeyView> {
    return this.keys.revoke(actor, id);
  }

  @Get('api-logs')
  @MerchantAccess(MerchantPermission.DEVELOPERS_MANAGE)
  apiLogs(
    @CurrentMerchantActor() actor: MerchantActor,
    @Query() query: ListApiRequestsQueryDto,
  ): Promise<CursorPage<ApiRequestView>> {
    return this.logs.list(actor.merchantId, query);
  }
}

export interface PingResponse {
  merchantId: string;
  mode: string;
  keyKind: string;
  scopes: string[];
}

// Public integrator API: "is my key working, and what can it do?"
@ApiTags('Keys')
@ApiBearerAuth('apiKey')
@Controller('merchant/ping')
@UseGuards(MerchantGuard)
export class MerchantPingController {
  @Get()
  @AllowApiKey()
  ping(@Req() request: RequestWithUser): PingResponse {
    const principal = request.principal;
    if (principal?.kind !== 'api_key') {
      // Key-only: a dashboard session has no key to describe.
      throw new UnauthenticatedException();
    }
    return {
      merchantId: principal.merchantId,
      mode: principal.mode,
      keyKind: principal.keyKind,
      scopes: principal.scopes,
    };
  }
}
