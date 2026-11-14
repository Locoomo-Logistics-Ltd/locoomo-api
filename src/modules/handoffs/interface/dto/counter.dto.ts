import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ID_TYPES } from '../../application/collect-with-id.service';
import { REFUSAL_REASONS } from '../../application/refuse-drop-off.service';
import type { RefusalReason } from '../../application/refuse-drop-off.service';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class RefuseDropOffDto {
  @IsIn(REFUSAL_REASONS)
  reason!: RefusalReason;

  // Shown to the sender.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;

  // From POST /handoffs/upload-signature.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  photoPublicId?: string;
}

export class CollectWithIdDto {
  // As written on the ID shown.
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  collectorName!: string;

  // Last 4 digits of the receiver's phone, given by the person collecting.
  @Matches(/^\d{4}$/, { message: 'phoneLast4 must be 4 digits' })
  phoneLast4!: string;

  @IsIn(ID_TYPES)
  idType!: (typeof ID_TYPES)[number];

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z0-9]{4}$/, {
    message: 'idLast4 must be the last 4 characters of the ID number',
  })
  idLast4!: string;

  // A photo of the person collecting or their ID (POST /handoffs/upload-signature).
  @IsOptional()
  @IsString()
  @MaxLength(255)
  photoPublicId?: string;
}

export class RaiseOrderExceptionDto {
  @IsIn(['lost', 'damaged'])
  type!: 'lost' | 'damaged';

  // Internal: what happened, who's looking into it.
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  note!: string;
}
