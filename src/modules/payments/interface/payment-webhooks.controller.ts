import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../../common/auth/decorators/public.decorator';
import { HandlePaymentWebhookService } from '../application/handle-payment-webhook.service';
import { PaymentProviderName } from '../domain/payment-provider-name.enum';

// Path is hardcoded in bootstrap.ts's raw-body middleware registration —
// keep the two in sync if this ever moves.
@Controller('payments/webhooks')
export class PaymentWebhooksController {
  constructor(
    private readonly handlePaymentWebhookService: HandlePaymentWebhookService,
  ) {}

  @Public()
  @Post('paystack')
  @HttpCode(HttpStatus.OK)
  async paystack(@Req() req: Request): Promise<{ received: true }> {
    // req.body is a raw Buffer here, not parsed JSON — express.raw()
    // middleware is scoped to exactly this path in bootstrap.ts, ahead of
    // Nest's global JSON body parser, because the signature must be verified
    // over the exact bytes Paystack sent (see PaystackPaymentProvider).
    const rawBody = req.body as Buffer;
    const signature = req.headers['x-paystack-signature'] as string | undefined;

    await this.handlePaymentWebhookService.handle(
      PaymentProviderName.PAYSTACK,
      rawBody,
      signature,
    );

    return { received: true };
  }
}
