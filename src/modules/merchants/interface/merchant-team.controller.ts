import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import {
  RequireRecentAuth,
  RequireVerifiedEmail,
} from '../../../common/auth/decorators/account-requirements.decorator';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Public } from '../../../common/auth/decorators/public.decorator';
import { auditContextFrom } from '../../../common/audit/audit.service';
import type { MerchantActor } from '../application/merchant-state';
import {
  InvitePreview,
  MerchantTeamService,
  TeamInviteView,
  TeamMemberView,
  TeamView,
} from '../application/merchant-team.service';
import { MerchantRole } from '../domain/merchant.enums';
import { MerchantPermission } from '../domain/merchant-permissions';
import {
  ChangeMemberRoleDto,
  InviteTeamMemberDto,
  InviteTokenDto,
  TransferOwnershipDto,
} from './dto/merchant-team.dto';
import {
  CurrentMerchantActor,
  MerchantAccess,
  MerchantGuard,
} from './merchant.guard';

@ApiExcludeController()
@Controller('merchant/team')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class MerchantTeamController {
  constructor(private readonly team: MerchantTeamService) {}

  @Get()
  @MerchantAccess()
  get(@CurrentMerchantActor() actor: MerchantActor): Promise<TeamView> {
    return this.team.team(actor.merchantId);
  }

  @Post('invites')
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @MerchantAccess(MerchantPermission.TEAM_MANAGE)
  invite(
    @CurrentMerchantActor() actor: MerchantActor,
    @Body() dto: InviteTeamMemberDto,
  ): Promise<TeamInviteView> {
    return this.team.invite(actor, dto.email, dto.role);
  }

  @Delete('invites/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @MerchantAccess(MerchantPermission.TEAM_MANAGE)
  revokeInvite(
    @CurrentMerchantActor() actor: MerchantActor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.team.revokeInvite(actor, id);
  }

  // Leave the team (anyone but the owner). Declared before members/:id.
  @Delete('members/me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @MerchantAccess()
  leave(@CurrentMerchantActor() actor: MerchantActor): Promise<void> {
    return this.team.removeMember(actor, actor.memberId);
  }

  @Patch('members/:id')
  @RequireRecentAuth()
  @MerchantAccess(MerchantPermission.TEAM_MANAGE)
  changeRole(
    @CurrentMerchantActor() actor: MerchantActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeMemberRoleDto,
  ): Promise<TeamMemberView> {
    return this.team.changeRole(actor, id, dto.role);
  }

  @Delete('members/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @MerchantAccess(MerchantPermission.TEAM_MANAGE)
  remove(
    @CurrentMerchantActor() actor: MerchantActor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.team.removeMember(actor, id);
  }

  @Post('transfer-ownership')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireRecentAuth()
  @MerchantAccess(MerchantPermission.OWNERSHIP)
  transferOwnership(
    @CurrentMerchantActor() actor: MerchantActor,
    @Body() dto: TransferOwnershipDto,
  ): Promise<void> {
    return this.team.transferOwnership(actor, dto.memberId);
  }
}

// Accepting an invitation: the invitee isn't a member yet.
@ApiExcludeController()
@Controller('merchant/invites')
@UseGuards(MerchantGuard)
@RequireVerifiedEmail()
export class MerchantInvitesController {
  constructor(private readonly team: MerchantTeamService) {}

  // Before sign-in: who invited me, as what, to which email.
  @Post('preview')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  preview(@Body() dto: InviteTokenDto): Promise<InvitePreview> {
    return this.team.preview(dto.token);
  }

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InviteTokenDto,
    @Req() request: Request,
  ): Promise<{ merchantId: string; role: MerchantRole }> {
    return this.team.accept(user.id, dto.token, auditContextFrom(request));
  }
}
