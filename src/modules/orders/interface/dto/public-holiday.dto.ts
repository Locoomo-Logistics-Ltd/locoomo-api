import { Transform } from 'class-transformer';
import {
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class AddPublicHolidayDto {
  // Lagos calendar date.
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
  @IsISO8601({ strict: true })
  date!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;
}

export class HolidayDateParam {
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
  @IsISO8601({ strict: true })
  date!: string;
}

export class ListPublicHolidaysQueryDto {
  @IsOptional()
  @Matches(DATE, { message: 'from must be YYYY-MM-DD' })
  from?: string;
}
