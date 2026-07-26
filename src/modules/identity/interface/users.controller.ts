import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { InviteUserService } from '../application/invite-user.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { UserResponseDto } from './dto/user-response.dto';

// No @Public() here — the global AuthGuard default-denies, and @Roles below
// requires an authenticated Admin on top of that. Kept separate from
// AuthController, which is exclusively session-less routes.
@Controller('users')
export class UsersController {
  constructor(private readonly inviteUserService: InviteUserService) {}

  @Roles(UserRole.ADMIN)
  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  invite(@Body() dto: InviteUserDto): Promise<UserResponseDto> {
    return this.inviteUserService.invite(dto);
  }
}
