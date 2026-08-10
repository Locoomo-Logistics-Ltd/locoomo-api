import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { InvalidWebhookSignatureException } from '../domain/exceptions/invalid-webhook-signature.exception';
import { PaymentIntentStatus } from '../domain/payment-intent-status.enum';
import { PaymentProviderName } from '../domain/payment-provider-name.enum';
import { PaymentIntentEntity } from '../infrastructure/entities/payment-intent.entity';
import { PaymentProviderRegistry } from '../infrastructure/payment-provider.registry';
import { ConfirmPaymentIntentPaidService } from './confirm-payment-intent-paid.service';

export const PAYMENT_WEBHOOK_IDEMPOTENCY_SCOPE = 'payments.webhook';

@Injectable()
export class HandlePaymentWebhookService {
  private readonly logger = new Logger(HandlePaymentWebhookService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly paymentProviderRegistry: PaymentProviderRegistry,
    private readonly idempotencyService: IdempotencyService,
    private readonly confirmPaymentIntentPaidService: ConfirmPaymentIntentPaidService,
  ) {}

  async handle(
    providerName: PaymentProviderName,
    rawBody: Buffer,
    signatureHeader: string | undefined,
  ): Promise<void> {
    const provider = this.paymentProviderRegistry.get(providerName);

    if (!provider.verifyWebhookSignature(rawBody, signatureHeader)) {
      throw new InvalidWebhookSignatureException(providerName);
    }

    const event = provider.parseWebhookEvent(rawBody);
    if (event.type !== 'charge.success') {
      // Failed/other events are a no-op — a PENDING intent that never
      // succeeds simply expires via ExpirePaymentIntentsService, which
      // covers this path without a second branch to get wrong.
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      const { alreadyProcessed } =
        await this.idempotencyService.withIdempotency(
          PAYMENT_WEBHOOK_IDEMPOTENCY_SCOPE,
          event.providerReference,
          manager,
          async () => {
            const intentRepo = manager.getRepository(PaymentIntentEntity);
            const intent = await intentRepo.findOneBy({
              providerReference: event.providerReference,
            });
            if (!intent) {
              this.logger.warn(
                `Webhook for unknown providerReference ${event.providerReference}`,
              );
              return;
            }
            if (intent.status !== PaymentIntentStatus.PENDING) {
              // Already handled (a legitimate retry) or expired out from
              // under a late webhook — nothing to do either way.
              return;
            }

            // Never trust the webhook payload's amount/status alone — a
            // server-to-server re-verify is Paystack's own recommendation and
            // the actual security boundary here.
            const verification = await provider.verify(event.providerReference);
            if (
              verification.status !== 'success' ||
              verification.amountKobo !== intent.amountKobo
            ) {
              this.logger.error(
                `Webhook verification mismatch for intent ${intent.id}: ` +
                  `status=${verification.status} amount=${verification.amountKobo} expected=${intent.amountKobo}`,
              );
              return;
            }

            await this.confirmPaymentIntentPaidService.confirm(
              intent,
              verification,
              manager,
            );
          },
        );

      if (alreadyProcessed) {
        this.logger.log(
          `Webhook for ${event.providerReference} already processed, skipping`,
        );
      }
    });
  }
}
