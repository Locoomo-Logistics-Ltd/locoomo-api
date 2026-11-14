import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  NotEquals,
} from 'class-validator';
import { CursorQueryDto } from '../../../../common/pagination/cursor-query.dto';
import { MAX_ADJUSTMENT_KOBO, WalletEntryType } from '../../domain/wallet';

const ENTRY_TYPES = Object.values(WalletEntryType);

export class ListWalletEntriesQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(ENTRY_TYPES)
  type?: WalletEntryType;

  /** Inclusive, ISO-8601. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Exclusive, ISO-8601. */
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class ListWalletHoldsQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(['active', 'captured', 'released'])
  status?: 'active' | 'captured' | 'released';
}

export class AdminWalletModeQueryDto {
  @IsOptional()
  @IsIn(['test', 'live'])
  mode: 'test' | 'live' = 'live';
}

export class AdminListWalletEntriesQueryDto extends ListWalletEntriesQueryDto {
  @IsOptional()
  @IsIn(['test', 'live'])
  mode: 'test' | 'live' = 'live';
}

export class AdminListWalletHoldsQueryDto extends ListWalletHoldsQueryDto {
  @IsOptional()
  @IsIn(['test', 'live'])
  mode: 'test' | 'live' = 'live';
}

export class RequestWalletAdjustmentDto {
  @IsIn(['test', 'live'])
  mode!: 'test' | 'live';

  /** Signed kobo: positive credits the wallet, negative debits it. */
  @Type(() => Number)
  @IsInt()
  @NotEquals(0)
  @Min(-MAX_ADJUSTMENT_KOBO)
  @Max(MAX_ADJUSTMENT_KOBO)
  @ApiProperty({
    minimum: -MAX_ADJUSTMENT_KOBO,
    maximum: MAX_ADJUSTMENT_KOBO,
  })
  amountKobo!: number;

  /** Why (internal; shown to the approving admin). */
  @IsString()
  @Length(3, 1000)
  reason!: string;

  /** Shown on the merchant's statement. Default: "Adjustment by Locoomo". */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  merchantNote?: string;
}

export class WalletView {
  mode!: 'test' | 'live';
  currency!: 'NGN';
  /** Σ every entry. May be negative after re-pricing (plan §8.4). */
  balanceKobo!: number;
  /** Set aside for shipments not yet dropped off. */
  heldKobo!: number;
  /** balance − held: what new shipments can use. */
  availableKobo!: number;
  updatedAt!: string;
}

export class WalletEntryView {
  id!: string;
  @ApiProperty({ enum: ENTRY_TYPES })
  type!: WalletEntryType;
  /** Signed: credits positive, debits negative. */
  amountKobo!: number;
  balanceAfterKobo!: number;
  description!: string;
  shipmentId!: string | null;
  createdAt!: string;
}

export class WalletEntryListView {
  @ApiProperty({ type: [WalletEntryView] })
  items!: WalletEntryView[];
  nextCursor!: string | null;
  hasMore!: boolean;
}

export class WalletHoldView {
  id!: string;
  shipmentId!: string;
  status!: 'active' | 'captured' | 'released';
  amountKobo!: number;
  capturedKobo!: number | null;
  createdAt!: string;
  resolvedAt!: string | null;
}

export class WalletHoldListView {
  @ApiProperty({ type: [WalletHoldView] })
  items!: WalletHoldView[];
  nextCursor!: string | null;
  hasMore!: boolean;
}

export class WalletAdjustmentRequestedView {
  approvalId!: string;
  status!: string;
  summary!: string;
  expiresAt!: string;
}
