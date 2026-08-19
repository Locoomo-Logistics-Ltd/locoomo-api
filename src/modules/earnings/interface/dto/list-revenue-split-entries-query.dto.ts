import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination-query.dto';
import { PayoutStatus } from '../../domain/payout-status.enum';
import { RevenueSplitPartyType } from '../../domain/party-type.enum';

const PARTY_TYPES = Object.values(RevenueSplitPartyType);
const PAYOUT_STATUSES = Object.values(PayoutStatus);

export class ListRevenueSplitEntriesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(PARTY_TYPES, {
    message: `partyType must be one of: ${PARTY_TYPES.join(', ')}`,
  })
  partyType?: RevenueSplitPartyType;

  @IsOptional()
  @IsIn(PAYOUT_STATUSES, {
    message: `payoutStatus must be one of: ${PAYOUT_STATUSES.join(', ')}`,
  })
  payoutStatus?: PayoutStatus;
}
