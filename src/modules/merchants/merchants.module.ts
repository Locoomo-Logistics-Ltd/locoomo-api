import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CloudinaryModule } from '../../common/cloudinary/cloudinary.module';
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
import { MerchantNotifierService } from './application/merchant-notifier.service';
import { MerchantTeamService } from './application/merchant-team.service';
import { ApiKeyEntity } from './infrastructure/entities/api-key.entity';
import { MerchantApiRequestEntity } from './infrastructure/entities/merchant-api-request.entity';
import { MerchantBankAccountEntity } from './infrastructure/entities/merchant-bank-account.entity';
import { MerchantDirectorEntity } from './infrastructure/entities/merchant-director.entity';
import { MerchantDocumentEntity } from './infrastructure/entities/merchant-document.entity';
import { MerchantInviteEntity } from './infrastructure/entities/merchant-invite.entity';
import { MerchantMemberEntity } from './infrastructure/entities/merchant-member.entity';
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

// External merchants (plan v2): accounts, teams, onboarding/KYC and the
// admin review queue. Later phases add API keys, shipments, wallet and
// webhooks here. Talks to other modules only through their exported
// application services.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      MerchantEntity,
      MerchantMemberEntity,
      MerchantInviteEntity,
      MerchantDirectorEntity,
      MerchantDocumentEntity,
      MerchantBankAccountEntity,
      MerchantReviewItemEntity,
      ApiKeyEntity,
      MerchantApiRequestEntity,
    ]),
    // UserLookupService (team names/emails), AdminPermissionService (KYC
    // reviewers to notify), MfaService (2FA before live keys).
    IdentityModule,
    NotificationsModule,
    // PaystackBankService: bank list + account resolution.
    PaymentsModule,
    CloudinaryModule,
    // NodesService.searchAvailable/getAvailable: the checkout picker.
    NodesModule,
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
  ],
})
export class MerchantsModule {}
