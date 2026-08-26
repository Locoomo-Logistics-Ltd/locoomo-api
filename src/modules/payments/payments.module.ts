import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { IdentityModule } from '../identity/identity.module';
import { NodesModule } from '../nodes/nodes.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { AdminPricingService } from './application/admin-pricing.service';
import { ConfirmPaymentIntentPaidService } from './application/confirm-payment-intent-paid.service';
import { CreatePaymentIntentService } from './application/create-payment-intent.service';
import { ExpirePaymentIntentsService } from './application/expire-payment-intents.service';
import { HandlePaymentWebhookService } from './application/handle-payment-webhook.service';
import { PaymentIntentQueryService } from './application/payment-intent-query.service';
import { PricingService } from './application/pricing.service';
import { PaymentIntentEntity } from './infrastructure/entities/payment-intent.entity';
import { PricingRuleEntity } from './infrastructure/entities/pricing-rule.entity';
import { PaymentProviderRegistry } from './infrastructure/payment-provider.registry';
import { PaystackBankService } from './application/paystack-bank.service';
import { PaystackPaymentProvider } from './infrastructure/paystack-payment-provider';
import { BanksController } from './interface/banks.controller';
import { PaymentIntentsController } from './interface/payment-intents.controller';
import { PaymentWebhooksController } from './interface/payment-webhooks.controller';
import { PricingController } from './interface/pricing.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([PaymentIntentEntity, PricingRuleEntity]),
    IdempotencyModule,
    NodesModule,
    IdentityModule,
    NotificationsModule,
    OrdersModule,
  ],
  controllers: [
    PaymentIntentsController,
    PaymentWebhooksController,
    PricingController,
    BanksController,
  ],
  providers: [
    PricingService,
    AdminPricingService,
    CreatePaymentIntentService,
    PaymentIntentQueryService,
    ConfirmPaymentIntentPaidService,
    HandlePaymentWebhookService,
    ExpirePaymentIntentsService,
    PaystackPaymentProvider,
    PaymentProviderRegistry,
    PaystackBankService,
  ],
  // PaystackBankService: riders/node-operators inject this for their own
  // PATCH me/payout-account verification — narrow cross-module export, same
  // template as NodesService.reserveCapacitySlot.
  exports: [PaystackBankService],
})
export class PaymentsModule {}
