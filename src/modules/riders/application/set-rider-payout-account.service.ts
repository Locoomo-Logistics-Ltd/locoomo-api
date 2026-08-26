import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SetPayoutAccountDto } from '../../../common/dto/set-payout-account.dto';
import { EntityNotFoundException } from '../../../common/exceptions';
import { PaystackBankService } from '../../payments/application/paystack-bank.service';
import { CloudinaryService } from '../infrastructure/cloudinary.service';
import { RiderProfileEntity } from '../infrastructure/entities/rider-profile.entity';
import { RiderVerificationDocumentEntity } from '../infrastructure/entities/rider-verification-document.entity';
import { RiderResponseDto } from '../interface/dto/rider-response.dto';
import { toRiderResponseDto } from './rider-response.mapper';

// Verify-first: resolves the real account name from Paystack before ever
// writing anything. A failed resolve (BankAccountVerificationFailedException,
// thrown by PaystackBankService) leaves the profile's existing payout
// account — if any — completely untouched, so a bad re-verification attempt
// can never wipe out an already-working one.
@Injectable()
export class SetRiderPayoutAccountService {
  constructor(
    @InjectRepository(RiderProfileEntity)
    private readonly profiles: Repository<RiderProfileEntity>,
    @InjectRepository(RiderVerificationDocumentEntity)
    private readonly documents: Repository<RiderVerificationDocumentEntity>,
    private readonly paystackBankService: PaystackBankService,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async set(
    userId: string,
    dto: SetPayoutAccountDto,
  ): Promise<RiderResponseDto> {
    const profile = await this.profiles.findOneBy({ userId });
    if (!profile) {
      throw new EntityNotFoundException('RiderProfile', userId);
    }

    const { accountName } = await this.paystackBankService.resolveAccountNumber(
      dto.bankCode,
      dto.accountNumber,
    );

    profile.payoutBankCode = dto.bankCode;
    profile.payoutBankName = dto.bankName;
    profile.payoutAccountNumber = dto.accountNumber;
    profile.payoutAccountName = accountName;
    profile.payoutAccountVerifiedAt = new Date();
    const saved = await this.profiles.save(profile);

    const docs = await this.documents.findBy({ riderProfileId: saved.id });
    return toRiderResponseDto(saved, docs, this.cloudinaryService);
  }
}
