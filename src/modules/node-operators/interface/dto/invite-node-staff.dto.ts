import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

// Same fields as identity's InviteUserDto minus `role` — implicit
// (NODE_STAFF, hardcoded by InviteUserService.inviteNodeStaff) and would be
// rejected by forbidNonWhitelisted if a caller tried to send one.
export class InviteNodeStaffDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @Matches(/^\+?[0-9]{7,15}$/, {
    message: 'phone must be a valid phone number',
  })
  phone!: string;
}
