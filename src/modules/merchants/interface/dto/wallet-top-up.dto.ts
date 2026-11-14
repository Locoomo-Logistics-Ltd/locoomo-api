import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CursorQueryDto } from '../../../../common/pagination/cursor-query.dto';
import {
  MAX_CARD_TOP_UP_KOBO,
  MIN_CARD_TOP_UP_KOBO,
} from '../../domain/wallet';

export class StartCardTopUpDto {
  /** What to pay, in kobo (₦1,000 to ₦10,000,000). Card fees are deducted
   * from what reaches the wallet. */
  @Type(() => Number)
  @IsInt()
  @Min(MIN_CARD_TOP_UP_KOBO)
  @Max(MAX_CARD_TOP_UP_KOBO)
  amountKobo!: number;
}

export class TopUpView {
  id!: string;
  mode!: 'test' | 'live';
  @ApiProperty({ enum: ['card', 'bank_transfer'] })
  method!: 'card' | 'bank_transfer';
  @ApiProperty({ enum: ['pending', 'succeeded', 'failed', 'abandoned'] })
  status!: 'pending' | 'succeeded' | 'failed' | 'abandoned';
  /** What the payer paid. */
  amountKobo!: number;
  /** Card processing fee (0 for transfers). */
  feeKobo!: number;
  /** What reached the wallet; null until it succeeds. */
  creditedKobo!: number | null;
  reference!: string;
  paidAt!: string | null;
  createdAt!: string;
}

export class StartedTopUpView {
  topUp!: TopUpView;
  /** Send the user here (Paystack's payment page). */
  authorizationUrl!: string;
}

export class TopUpListView {
  @ApiProperty({ type: [TopUpView] })
  items!: TopUpView[];
  nextCursor!: string | null;
  hasMore!: boolean;
}

export class FundingAccountView {
  bankName!: string;
  accountNumber!: string;
  accountName!: string;
  createdAt!: string;
}

export class AdminListTopUpsQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(['test', 'live'])
  mode: 'test' | 'live' = 'live';
}
