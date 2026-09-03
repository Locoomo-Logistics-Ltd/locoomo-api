import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SetPayoutAccountDto } from '../../../common/dto/set-payout-account.dto';
import { EntityNotFoundException } from '../../../common/exceptions';
import { PaystackBankService } from '../../payments/application/paystack-bank.service';
import { NodeMembershipRole } from '../domain/node-membership-role.enum';
import { NodeMembershipStatus } from '../domain/node-membership-status.enum';
import { NodeMembershipEntity } from '../infrastructure/entities/node-membership.entity';
import { NodeOperatorResponseDto } from '../interface/dto/node-operator-response.dto';
import { NodeOperatorQueryService } from './node-operator-query.service';

// Same verify-first shape as riders' SetRiderPayoutAccountService — see that
// file's comment. Scoped by (userId, nodeId), not userId alone — an
// operator can now have several memberships, so nodeId disambiguates which
// one's payout account is being set. Only an OWNER membership may do this;
// a staff (Phase 2) membership on the same Node is rejected the same way a
// non-member is — hidden as not-found, not a 403, matching the pattern
// already used elsewhere for resources a caller shouldn't be able to probe
// the existence of.
@Injectable()
export class SetNodePayoutAccountService {
  constructor(
    @InjectRepository(NodeMembershipEntity)
    private readonly memberships: Repository<NodeMembershipEntity>,
    private readonly paystackBankService: PaystackBankService,
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
  ) {}

  async set(
    userId: string,
    nodeId: string,
    dto: SetPayoutAccountDto,
  ): Promise<NodeOperatorResponseDto> {
    const membership = await this.memberships.findOneBy({
      userId,
      nodeId,
      status: NodeMembershipStatus.ACTIVE,
    });
    if (!membership || membership.roleAtNode !== NodeMembershipRole.OWNER) {
      throw new EntityNotFoundException('NodeMembership', nodeId);
    }

    const { accountName } = await this.paystackBankService.resolveAccountNumber(
      dto.bankCode,
      dto.accountNumber,
    );

    membership.payoutBankCode = dto.bankCode;
    membership.payoutBankName = dto.bankName;
    membership.payoutAccountNumber = dto.accountNumber;
    membership.payoutAccountName = accountName;
    membership.payoutAccountVerifiedAt = new Date();
    await this.memberships.save(membership);

    return this.nodeOperatorQueryService.getForNode(userId, nodeId);
  }
}
