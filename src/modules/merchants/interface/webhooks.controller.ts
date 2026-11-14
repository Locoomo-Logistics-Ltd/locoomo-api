import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireVerifiedEmail } from '../../../common/auth/decorators/account-requirements.decorator';
import type { CursorPage } from '../../../common/pagination/cursor';
import type { MerchantCaller } from '../application/merchant-state';
import { WebhookEndpointService } from '../application/webhook-endpoint.service';
import { ApiKeyScope } from '../domain/api-key';
import { MerchantPermission } from '../domain/merchant-permissions';
import {
  CreatedWebhookEndpointView,
  CreateWebhookEndpointDto,
  ListWebhookDeliveriesQueryDto,
  ReplayWebhooksDto,
  UpdateWebhookEndpointDto,
  WebhookDeliveryListView,
  WebhookDeliveryView,
  WebhookEndpointView,
  WebhookTestResultView,
} from './dto/webhook.dto';
import {
  CurrentMerchantCaller,
  MerchantApi,
  MerchantGuard,
} from './merchant.guard';

const MANAGE = (): MethodDecorator & ClassDecorator =>
  MerchantApi(
    ApiKeyScope.WEBHOOKS_MANAGE,
    MerchantPermission.DEVELOPERS_MANAGE,
  );

// MERCHANT_API.md §12. A key with webhooks:manage, or a dashboard session
// (Developers › Webhooks; mode from Locoomo-Mode).
@ApiTags('Webhooks')
@ApiBearerAuth('apiKey')
@Controller('merchant')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class WebhooksController {
  constructor(private readonly endpoints: WebhookEndpointService) {}

  @Get('webhook-endpoints')
  @MANAGE()
  @ApiOkResponse({ type: [WebhookEndpointView] })
  list(
    @CurrentMerchantCaller() caller: MerchantCaller,
  ): Promise<WebhookEndpointView[]> {
    return this.endpoints.list(caller);
  }

  /** Up to 5 per mode. The signing secret is returned once. */
  @Post('webhook-endpoints')
  @MANAGE()
  @ApiCreatedResponse({ type: CreatedWebhookEndpointView })
  create(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Body() dto: CreateWebhookEndpointDto,
  ): Promise<CreatedWebhookEndpointView> {
    return this.endpoints.create(caller, dto);
  }

  @Patch('webhook-endpoints/:id')
  @MANAGE()
  @ApiOkResponse({ type: WebhookEndpointView })
  update(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWebhookEndpointDto,
  ): Promise<WebhookEndpointView> {
    return this.endpoints.update(caller, id, dto);
  }

  @Delete('webhook-endpoints/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @MANAGE()
  remove(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.endpoints.remove(caller, id);
  }

  /** New secret; the old one keeps signing for 24 hours. */
  @Post('webhook-endpoints/:id/roll-secret')
  @HttpCode(HttpStatus.OK)
  @MANAGE()
  @ApiOkResponse({ type: CreatedWebhookEndpointView })
  rollSecret(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CreatedWebhookEndpointView> {
    return this.endpoints.rollSecret(caller, id);
  }

  /** Sends a `webhook.test` event now and reports what your endpoint answered. */
  @Post('webhook-endpoints/:id/test')
  @HttpCode(HttpStatus.OK)
  @MANAGE()
  @ApiOkResponse({ type: WebhookTestResultView })
  sendTest(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WebhookTestResultView> {
    return this.endpoints.sendTest(caller, id);
  }

  /** Resend every subscribed event since a time (within 30 days). */
  @Post('webhook-endpoints/:id/replay')
  @HttpCode(HttpStatus.OK)
  @MANAGE()
  replay(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplayWebhooksDto,
  ): Promise<{ queued: number }> {
    return this.endpoints.replay(caller, id, dto.since);
  }

  /** Delivery log (30 days), newest first. */
  @Get('webhook-deliveries')
  @MANAGE()
  @ApiOkResponse({ type: WebhookDeliveryListView })
  deliveries(
    @CurrentMerchantCaller() caller: MerchantCaller,
    @Query() query: ListWebhookDeliveriesQueryDto,
  ): Promise<CursorPage<WebhookDeliveryView>> {
    return this.endpoints.deliveries(caller, query);
  }
}
