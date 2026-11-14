import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { isIP } from 'net';
import { CursorQueryDto } from '../../../../common/pagination/cursor-query.dto';
import {
  ROLL_OVERLAP_SECONDS,
  SELECTABLE_SECRET_SCOPES,
} from '../../domain/api-key';
import type { ApiKeyKind, ApiKeyMode, RollOverlap } from '../../domain/api-key';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const MODES: ApiKeyMode[] = ['test', 'live'];
const KINDS: ApiKeyKind[] = ['secret', 'publishable'];

@ValidatorConstraint({ name: 'isCidrList' })
class IsCidrList implements ValidatorConstraintInterface {
  validate(values: unknown): boolean {
    return (
      Array.isArray(values) &&
      values.every((value) => {
        if (typeof value !== 'string') {
          return false;
        }
        const [address, bits, extra] = value.split('/');
        const family = isIP(address);
        if (family === 0 || extra !== undefined) {
          return false;
        }
        if (bits === undefined) {
          return true;
        }
        const n = Number(bits);
        return /^\d+$/.test(bits) && n >= 0 && n <= (family === 4 ? 32 : 128);
      })
    );
  }

  defaultMessage(): string {
    return 'allowedIps must be IP addresses or CIDR ranges, e.g. 203.0.113.7 or 203.0.113.0/24';
  }
}

@ValidatorConstraint({ name: 'isOriginList' })
class IsOriginList implements ValidatorConstraintInterface {
  validate(values: unknown): boolean {
    return (
      Array.isArray(values) &&
      values.every((value) => {
        if (typeof value !== 'string') {
          return false;
        }
        try {
          const url = new URL(value);
          return (
            (url.protocol === 'https:' || url.protocol === 'http:') &&
            url.origin === value
          );
        } catch {
          return false;
        }
      })
    );
  }

  defaultMessage(): string {
    return 'allowedOrigins must be origins like https://shop.example.com (no path or trailing slash)';
  }
}

class ApiKeySettingsDto {
  // Secret keys only. Defaults to every scope except webhooks:manage.
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(SELECTABLE_SECRET_SCOPES, { each: true })
  scopes?: string[];

  // Secret keys only. Empty = any IP.
  @IsOptional()
  @ArrayMaxSize(50)
  @Validate(IsCidrList)
  allowedIps?: string[];

  // Publishable keys only. Empty = any origin.
  @IsOptional()
  @ArrayMaxSize(50)
  @Validate(IsOriginList)
  allowedOrigins?: string[];

  // Publishable keys only.
  @IsOptional()
  @IsBoolean()
  hidePrices?: boolean;
}

export class CreateApiKeyDto extends ApiKeySettingsDto {
  @IsIn(MODES)
  mode!: ApiKeyMode;

  @IsIn(KINDS)
  kind!: ApiKeyKind;

  // Shown in the dashboard and API logs, e.g. "Production server".
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;
}

export class UpdateApiKeyDto extends ApiKeySettingsDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;
}

export class RollApiKeyDto {
  // How long the old key keeps working next to the new one.
  @IsIn(Object.keys(ROLL_OVERLAP_SECONDS))
  expireOldIn!: RollOverlap;
}

export class ApiKeyModeQueryDto {
  @IsOptional()
  @IsIn(MODES)
  mode: ApiKeyMode = 'test';
}

export class RevokeAllApiKeysDto {
  @IsIn(MODES)
  mode!: ApiKeyMode;
}

export class ListApiRequestsQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(MODES)
  mode: ApiKeyMode = 'test';

  @IsOptional()
  @IsString()
  @MaxLength(36)
  apiKeyId?: string;

  // `errors` = status ≥ 400 only.
  @IsOptional()
  @IsIn(['all', 'errors'])
  outcome: 'all' | 'errors' = 'all';
}
