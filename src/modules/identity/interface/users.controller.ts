import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { InviteUserService } from '../application/invite-user.service';
import { MyProfileService } from '../application/my-profile.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UserResponseDto } from './dto/user-response.dto';

// No @Public() here — the global AuthGuard default-denies. Kept separate
// from AuthController, which is exclusively session-less routes. Not every
// route below is Admin-only, though — `me`/`me` (PATCH) are open to any
// authenticated role via the global AuthGuard alone, no @Roles.
@Controller('users')
export class UsersController {
  constructor(
    private readonly inviteUserService: InviteUserService,
    private readonly myProfileService: MyProfileService,
  ) {}

  @Roles(UserRole.ADMIN)
  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  invite(@Body() dto: InviteUserDto): Promise<UserResponseDto> {
    return this.inviteUserService.invite(dto);
  }

  @Get('me')
  getMine(@CurrentUser() user: AuthenticatedUser): Promise<UserResponseDto> {
    return this.myProfileService.getMine(user.id);
  }

  // Only `phone` today — see UpdateProfileDto. This is what closes the
  // "phone was never collected at signup" gap for both password and Google
  // accounts, and is the hard precondition OnboardRiderService/
  // OnboardNodeService check before letting Rider/NodeOperator onboard.
  @Patch('me')
  updateMine(
    @Body() dto: UpdateProfileDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    return this.myProfileService.updateMine(user.id, dto);
  }
}
