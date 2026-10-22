import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../../../common/auth/decorators/public.decorator';
import { CourierWebhookService } from '../application/courier-webhook.service';

// One route for every courier: POST /api/v1/logistics/webhooks/:providerKey
// (e.g. /sendii). bootstrap.ts gives this path prefix a raw body parser —
// signatures are over the exact bytes received. Public (verified by the
// provider's signature instead) and unthrottled (couriers burst from a few
// IPs; a 429 just means a delayed redelivery).
@Public()
@SkipThrottle()
@Controller('logistics/webhooks')
export class CourierWebhooksController {
  constructor(private readonly courierWebhookService: CourierWebhookService) {}

  @Post(':providerKey')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('providerKey') providerKey: string,
    @Req() req: Request,
  ): Promise<{ received: true }> {
    await this.courierWebhookService.receive(
      providerKey,
      req.body as Buffer,
      req.headers as Record<string, string | undefined>,
    );
    return { received: true };
  }
}
