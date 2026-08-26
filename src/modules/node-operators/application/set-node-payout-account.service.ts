import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SetPayoutAccountDto } from '../../../common/dto/set-payout-account.dto';
import { EntityNotFoundException } from '../../../common/exceptions';
import { PaystackBankService } from '../../payments/application/paystack-bank.service';
import { NodeOperatorProfileEntity } from '../infrastructure/entities/node-operator-profile.entity';
import { NodeOperatorResponseDto } from '../interface/dto/node-operator-response.dto';
import { NodeOperatorQueryService } from './node-operator-query.service';

// Same verify-first shape as riders' SetRiderPayoutAccountService — see that
// file's comment. Writes onto NodeOperatorProfileEntity, not NodeEntity:
// the Node itself has no login/session, so its payout account is owned by
// whichever operator profile manages it (MVP one-operator-per-node).
@Injectable()
export class SetNodePayoutAccountService {
  constructor(
    @InjectRepository(NodeOperatorProfileEntity)
    private readonly profiles: Repository<NodeOperatorProfileEntity>,
    private readonly paystackBankService: PaystackBankService,
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
  ) {}

  async set(
    userId: string,
    dto: SetPayoutAccountDto,
  ): Promise<NodeOperatorResponseDto> {
    const profile = await this.profiles.findOneBy({ userId });
    if (!profile) {
      throw new EntityNotFoundException('NodeOperatorProfile', userId);
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
    await this.profiles.save(profile);

    return this.nodeOperatorQueryService.getMine(userId);
  }
}
