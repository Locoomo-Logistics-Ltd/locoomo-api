import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CloudinaryModule } from '../../common/cloudinary/cloudinary.module';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { IdentityModule } from '../identity/identity.module';
import { NodesModule } from '../nodes/nodes.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminMerchantsService } from './application/admin-merchants.service';
import { ApiKeyAuthenticatorService } from './application/api-key-authenticator.service';
import { ApiKeyService } from './application/api-key.service';
import { ApiRateLimiter } from './application/api-rate-limiter';
import { ApiRequestLogService } from './application/api-request-log.service';
import { MerchantAccountService } from './application/merchant-account.service';
import { MerchantBankAccountService } from './application/merchant-bank-account.service';
import { MerchantCatalogService } from './application/merchant-catalog.service';
import { MerchantContextService } from './application/merchant-context.service';
import { MerchantShipmentService } from './application/merchant-shipment.service';
import { ShipmentEventsService } from './application/shipment-events.service';
import { ShipmentSimulatorService } from './application/shipment-simulator.service';
import { WebhookDispatcherService } from './application/webhook-dispatcher.service';
import { WebhookEmitterService } from './application/webhook-emitter.service';
import { WebhookEndpointService } from './application/webhook-endpoint.service';
import { MerchantNotifierService } from './application/merchant-notifier.service';
import { MerchantTeamService } from './application/merchant-team.service';
import { AdminWalletService } from './application/admin-wallet.service';
import { WalletReconciliationService } from './application/wallet-reconciliation.service';
import { WalletService } from './application/wallet.service';
import { WalletTopUpService } from './application/wallet-top-up.service';
import { MerchantFundingAccountEntity } from './infrastructure/entities/merchant-funding-account.entity';
import { WalletTopUpEntity } from './infrastructure/entities/wallet-top-up.entity';
import { MerchantWalletEntity } from './infrastructure/entities/merchant-wallet.entity';
import { WalletEntryEntity } from './infrastructure/entities/wallet-entry.entity';
import { WalletHoldEntity } from './infrastructure/entities/wallet-hold.entity';
import { AdminMerchantWalletController } from './interface/admin-merchant-wallet.controller';
import {
  MerchantPricingController,
  TestWalletController,
  WalletController,
} from './interface/wallet.controller';
import { AdminModule } from '../admin/admin.module';
import { HandoffsModule } from '../handoffs/handoffs.module';
import { OrdersModule } from '../orders/orders.module';
import { TrackingModule } from '../tracking/tracking.module';
import { LiveShipmentSyncService } from './application/live-shipment-sync.service';
import { ShipmentExpiryService } from './application/shipment-expiry.service';
import { ShipmentPresenter } from './application/shipment-presenter';
import { ShipmentLabelService } from './application/shipment-label.service';
import { ShipmentImportService } from './application/shipment-import.service';
import { MerchantPricingService } from './application/merchant-pricing.service';
import { WalletAlertsService } from './application/wallet-alerts.service';
import { VolumeDiscountTierSetEntity } from './infrastructure/entities/volume-discount-tier-set.entity';
import { AdminMerchantPricingController } from './interface/admin-merchant-pricing.controller';
import { EarningsModule } from '../earnings/earnings.module';
import { ShipmentImportEntity } from './infrastructure/entities/shipment-import.entity';
import { MerchantClaimEntity } from './infrastructure/entities/merchant-claim.entity';
import {
  MerchantReturnBatchEntity,
  MerchantReturnBatchItemEntity,
} from './infrastructure/entities/merchant-return-batch.entity';
import { ReturnBatchService } from './application/return-batch.service';
import {
  NodeReturnBatchesController,
  ReturnBatchesController,
  TestReturnBatchesController,
} from './interface/return-batches.controller';
import { NodeOperatorsModule } from '../node-operators/node-operators.module';
import {
  MerchantManifestEntity,
  MerchantManifestItemEntity,
} from './infrastructure/entities/merchant-manifest.entity';
import { ManifestService } from './application/manifest.service';
import { ReturnStorageService } from './application/return-storage.service';
import { MerchantOverviewService } from './application/merchant-overview.service';
import { MerchantReportsService } from './application/merchant-reports.service';
import { GoLiveChecklistService } from './application/go-live-checklist.service';
import { PickLinkService } from './application/pick-link.service';
import {
  PickLinksController,
  PublicPickController,
} from './interface/pick-links.controller';
import { PickLinkEntity } from './infrastructure/entities/pick-link.entity';
import {
  ExportDownloadController,
  ReportsController,
} from './interface/reports.controller';
import {
  HubManifestsController,
  ManifestsController,
  TestManifestsController,
} from './interface/manifests.controller';
import { MerchantClaimsService } from './application/merchant-claims.service';
import { AdminClaimsService } from './application/admin-claims.service';
import {
  ClaimsController,
  TestClaimsController,
} from './interface/claims.controller';
import { AdminMerchantClaimsController } from './interface/admin-merchant-claims.controller';
import { ShipmentImportRowEntity } from './infrastructure/entities/shipment-import-row.entity';
import { ShipmentImportsController } from './interface/shipment-imports.controller';
import { LabelRenderer } from './infrastructure/label-renderer';
import { DocumentRenderer } from './infrastructure/document-renderer';
import { MerchantDocumentsService } from './application/merchant-documents.service';
import {
  AdminMerchantDocumentsController,
  MerchantDocumentsController,
} from './interface/merchant-documents.controller';
import { ApiKeyEntity } from './infrastructure/entities/api-key.entity';
import { MerchantApiRequestEntity } from './infrastructure/entities/merchant-api-request.entity';
import { MerchantBankAccountEntity } from './infrastructure/entities/merchant-bank-account.entity';
import { MerchantDirectorEntity } from './infrastructure/entities/merchant-director.entity';
import { MerchantDocumentEntity } from './infrastructure/entities/merchant-document.entity';
import { MerchantInviteEntity } from './infrastructure/entities/merchant-invite.entity';
import { MerchantMemberEntity } from './infrastructure/entities/merchant-member.entity';
import { MerchantShipmentEventEntity } from './infrastructure/entities/merchant-shipment-event.entity';
import { MerchantShipmentEntity } from './infrastructure/entities/merchant-shipment.entity';
import { WebhookDeliveryEntity } from './infrastructure/entities/webhook-delivery.entity';
import { WebhookEndpointEntity } from './infrastructure/entities/webhook-endpoint.entity';
import { WebhookEventEntity } from './infrastructure/entities/webhook-event.entity';
import {
  HttpsWebhookTransport,
  WebhookTransport,
} from './infrastructure/webhook-transport';
import { MerchantReviewItemEntity } from './infrastructure/entities/merchant-review-item.entity';
import { MerchantEntity } from './infrastructure/entities/merchant.entity';
import { AdminMerchantsController } from './interface/admin-merchants.controller';
import {
  ApiKeysController,
  MerchantPingController,
} from './interface/api-keys.controller';
import {
  MerchantAccountController,
  MerchantBanksController,
} from './interface/merchant-account.controller';
import {
  MerchantInvitesController,
  MerchantTeamController,
} from './interface/merchant-team.controller';
import { MerchantCatalogController } from './interface/merchant-catalog.controller';
import { MerchantGuard } from './interface/merchant.guard';
import {
  ShipmentsController,
  TestShipmentsController,
} from './interface/shipments.controller';
import { WebhooksController } from './interface/webhooks.controller';

// External merchants (plan v2): accounts, teams, onboarding/KYC and the
// admin review queue. Later phases add API keys, shipments, wallet and
// webhooks here. Talks to other modules only through their exported
// application services.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      MerchantEntity,
      PickLinkEntity,
      MerchantMemberEntity,
      MerchantInviteEntity,
      MerchantDirectorEntity,
      MerchantDocumentEntity,
      MerchantBankAccountEntity,
      MerchantReviewItemEntity,
      ApiKeyEntity,
      MerchantApiRequestEntity,
      MerchantShipmentEntity,
      MerchantShipmentEventEntity,
      WebhookEndpointEntity,
      WebhookEventEntity,
      WebhookDeliveryEntity,
      MerchantWalletEntity,
      WalletEntryEntity,
      WalletHoldEntity,
      WalletTopUpEntity,
      MerchantFundingAccountEntity,
      ShipmentImportEntity,
      MerchantClaimEntity,
      MerchantReturnBatchEntity,
      MerchantReturnBatchItemEntity,
      MerchantManifestEntity,
      MerchantManifestItemEntity,
      ShipmentImportRowEntity,
      VolumeDiscountTierSetEntity,
    ]),
    // ApprovalService + registry: wallet adjustments need a second admin.
    AdminModule,
    // Live shipments (M4c): OrdersService (create/cancel/recall, status
    // bus), HandoffsModule (ParcelRecallService, SenderContactService),
    // TrackingModule (signed public tracking links).
    OrdersModule,
    HandoffsModule,
    TrackingModule,
    // RecordRevenueSplitService.currentPlatformPercent: the discount cap (E7).
    EarningsModule,
    // UserLookupService (team names/emails), AdminPermissionService (KYC
    // reviewers to notify), MfaService (2FA before live keys).
    IdentityModule,
    NotificationsModule,
    // PaystackBankService: bank list + account resolution.
    PaymentsModule,
    CloudinaryModule,
    // NodesService.searchAvailable/getAvailable: the checkout picker.
    NodesModule,
    // Idempotency-Key replay on POST /shipments and friends.
    IdempotencyModule,
    // NodeOperatorQueryService: which Nodes a staff member works at
    // (return batches handed over at the counter).
    NodeOperatorsModule,
  ],
  controllers: [
    MerchantAccountController,
    MerchantBanksController,
    MerchantTeamController,
    MerchantInvitesController,
    AdminMerchantsController,
    ApiKeysController,
    MerchantPingController,
    MerchantCatalogController,
    ShipmentsController,
    TestShipmentsController,
    WebhooksController,
    WalletController,
    TestWalletController,
    AdminMerchantWalletController,
    MerchantDocumentsController,
    AdminMerchantDocumentsController,
    ClaimsController,
    TestClaimsController,
    AdminMerchantClaimsController,
    ReturnBatchesController,
    TestReturnBatchesController,
    NodeReturnBatchesController,
    ManifestsController,
    TestManifestsController,
    HubManifestsController,
    ReportsController,
    ExportDownloadController,
    PickLinksController,
    PublicPickController,
    ShipmentImportsController,
    MerchantPricingController,
    AdminMerchantPricingController,
  ],
  providers: [
    MerchantContextService,
    MerchantNotifierService,
    MerchantAccountService,
    MerchantBankAccountService,
    MerchantTeamService,
    AdminMerchantsService,
    MerchantGuard,
    ApiRateLimiter,
    ApiKeyAuthenticatorService,
    ApiKeyService,
    ApiRequestLogService,
    MerchantCatalogService,
    ShipmentEventsService,
    MerchantShipmentService,
    ShipmentSimulatorService,
    WebhookEmitterService,
    WebhookDispatcherService,
    WebhookEndpointService,
    { provide: WebhookTransport, useClass: HttpsWebhookTransport },
    WalletService,
    AdminWalletService,
    WalletReconciliationService,
    WalletTopUpService,
    ShipmentPresenter,
    LiveShipmentSyncService,
    ShipmentExpiryService,
    LabelRenderer,
    DocumentRenderer,
    MerchantDocumentsService,
    MerchantClaimsService,
    AdminClaimsService,
    ReturnBatchService,
    ManifestService,
    ReturnStorageService,
    MerchantOverviewService,
    MerchantReportsService,
    GoLiveChecklistService,
    PickLinkService,
    ShipmentLabelService,
    ShipmentImportService,
    MerchantPricingService,
    WalletAlertsService,
  ],
})
export class MerchantsModule {}
