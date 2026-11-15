import { IsIn, IsOptional } from 'class-validator';
import type { DocumentFormat } from '../../domain/statement';

const FORMATS: DocumentFormat[] = ['pdf', 'csv'];

export class StatementFormatQueryDto {
  /** `pdf` (default) or `csv` (every line, for spreadsheets). */
  @IsOptional()
  @IsIn(FORMATS)
  format: DocumentFormat = 'pdf';
}

export class AdminStatementQueryDto extends StatementFormatQueryDto {
  @IsOptional()
  @IsIn(['test', 'live'])
  mode: 'test' | 'live' = 'live';
}
