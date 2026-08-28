import { IsString, Matches } from 'class-validator';

// Only phone today — the profile-completion gap registration/Google signup
// leave behind. Extensible later (firstName/lastName editing, ...) without a
// new route if that becomes a real need.
export class UpdateProfileDto {
  @IsString()
  @Matches(/^\+?[0-9]{7,15}$/, {
    message: 'phone must be a valid phone number',
  })
  phone!: string;
}
