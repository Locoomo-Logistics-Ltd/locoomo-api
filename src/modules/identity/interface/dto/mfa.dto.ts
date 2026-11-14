import {
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class MfaChallengeResponseDto {
  mfaRequired!: true;
  // Send back to POST /auth/mfa/verify with a code. Valid 5 minutes,
  // 5 attempts.
  mfaToken!: string;
}

export class TotpCodeDto {
  @IsString()
  @Matches(/^\d{6}$/, {
    message: 'code must be the 6-digit code from your authenticator app',
  })
  code!: string;
}

// Exactly one of `code` (6-digit TOTP) or `recoveryCode`.
export class SecondFactorDto {
  @ValidateIf((o: SecondFactorDto) => o.recoveryCode === undefined)
  @IsString()
  @Matches(/^\d{6}$/, {
    message: 'code must be the 6-digit code from your authenticator app',
  })
  code?: string;

  @IsOptional()
  @IsString()
  @Length(10, 20)
  recoveryCode?: string;
}

export class VerifyMfaChallengeDto extends SecondFactorDto {
  @IsString()
  @MaxLength(200)
  mfaToken!: string;
}

// Step-up: send whichever factor the account uses — 2FA code (or recovery
// code) when 2FA is on; otherwise the password; otherwise (Google-only
// accounts) a fresh Google ID token.
export class ReauthDto {
  @IsOptional()
  @IsString()
  @MaxLength(72)
  password?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, {
    message: 'code must be the 6-digit code from your authenticator app',
  })
  code?: string;

  @IsOptional()
  @IsString()
  @Length(10, 20)
  recoveryCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  googleIdToken?: string;
}
