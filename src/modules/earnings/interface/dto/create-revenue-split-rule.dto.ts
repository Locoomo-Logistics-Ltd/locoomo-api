import { IsInt, Max, Min } from 'class-validator';

// Sum-to-100 is a cross-field rule, checked in AdminRevenueSplitRuleService,
// not here — a single-field class-validator decorator can't express it.
export class CreateRevenueSplitRuleDto {
  @IsInt()
  @Min(0)
  @Max(100)
  riderPercent!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  nodePercent!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  platformPercent!: number;
}
