import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { PaymentsModule } from '../payments/payments.module';
import { ApproveRiderService } from './application/approve-rider.service';
import { GetUploadSignatureService } from './application/get-upload-signature.service';
import { OnboardRiderService } from './application/onboard-rider.service';
import { RiderCapacityService } from './application/rider-capacity.service';
import { RiderQueryService } from './application/rider-query.service';
import { SetRiderPayoutAccountService } from './application/set-rider-payout-account.service';
import { CloudinaryService } from './infrastructure/cloudinary.service';
import { RiderProfileEntity } from './infrastructure/entities/rider-profile.entity';
import { RiderVerificationDocumentEntity } from './infrastructure/entities/rider-verification-document.entity';
import { RidersController } from './interface/riders.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RiderProfileEntity,
      RiderVerificationDocumentEntity,
    ]),
    // ActivateUserService, for the approval flow.
    IdentityModule,
    // PaystackBankService, for PATCH me/payout-account verification.
    PaymentsModule,
  ],
  controllers: [RidersController],
  providers: [
    CloudinaryService,
    GetUploadSignatureService,
    OnboardRiderService,
    ApproveRiderService,
    RiderQueryService,
    RiderCapacityService,
    SetRiderPayoutAccountService,
  ],
  // Exported so handoffs can reserve/release a Rider's delivery-capacity
  // slot as part of its own accept/arrival transactions — never by reaching
  // into riders' domain/infrastructure directly.
  exports: [RiderCapacityService],
})
export class RidersModule {}
