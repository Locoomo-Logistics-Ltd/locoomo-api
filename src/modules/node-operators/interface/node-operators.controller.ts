import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { SetPayoutAccountDto } from '../../../common/dto/set-payout-account.dto';
import { ApproveNodeOperatorService } from '../application/approve-node-operator.service';
import { DispatchParcelService } from '../application/dispatch-parcel.service';
import { InviteNodeStaffService } from '../application/invite-node-staff.service';
import { NodeOperatorQueryService } from '../application/node-operator-query.service';
import { OnboardNodeService } from '../application/onboard-node.service';
import { SetNodePayoutAccountService } from '../application/set-node-payout-account.service';
import { SetNodeVisibilityService } from '../application/set-node-visibility.service';
import { UserResponseDto } from '../../identity/interface/dto/user-response.dto';
import { PaymentIntentResponseDto } from '../../payments/interface/dto/payment-intent-response.dto';
import { DispatchParcelDto } from './dto/dispatch-parcel.dto';
import { InviteNodeStaffDto } from './dto/invite-node-staff.dto';
import { NodeOperatorResponseDto } from './dto/node-operator-response.dto';
import { OnboardNodeDto } from './dto/onboard-node.dto';
import { PendingNodeOperatorResponseDto } from './dto/pending-node-operator-response.dto';
import { SetNodeVisibilityDto } from './dto/set-node-visibility.dto';

@Controller('node-operators')
export class NodeOperatorsController {
  constructor(
    private readonly onboardNodeService: OnboardNodeService,
    private readonly approveNodeOperatorService: ApproveNodeOperatorService,
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
    private readonly setNodePayoutAccountService: SetNodePayoutAccountService,
    private readonly inviteNodeStaffService: InviteNodeStaffService,
    private readonly setNodeVisibilityService: SetNodeVisibilityService,
    private readonly dispatchParcelService: DispatchParcelService,
  ) {}

  // First Node only — see OnboardNodeService.onboard.
  @Roles(UserRole.NODE_OPERATOR)
  @Post('onboarding')
  @HttpCode(HttpStatus.CREATED)
  onboard(
    @Body() dto: OnboardNodeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NodeOperatorResponseDto> {
    return this.onboardNodeService.onboard(user.id, dto);
  }

  // 2nd/3rd/... Node for an already-onboarded operator.
  @Roles(UserRole.NODE_OPERATOR)
  @Post('nodes')
  @HttpCode(HttpStatus.CREATED)
  addNode(
    @Body() dto: OnboardNodeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NodeOperatorResponseDto> {
    return this.onboardNodeService.addNode(user.id, dto);
  }

  // Every Node the caller has a membership at — replaces the old singular
  // GET /me, since an operator can now run more than one.
  @Roles(UserRole.NODE_OPERATOR)
  @Get('me/nodes')
  listMine(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NodeOperatorResponseDto[]> {
    return this.nodeOperatorQueryService.listMine(user.id);
  }

  @Roles(UserRole.NODE_OPERATOR)
  @Patch('nodes/:nodeId/payout-account')
  setPayoutAccount(
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() dto: SetPayoutAccountDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NodeOperatorResponseDto> {
    return this.setNodePayoutAccountService.set(user.id, nodeId, dto);
  }

  // Owner-only for :nodeId — see InviteNodeStaffService. Staff confirm
  // through the same POST /auth/invite/confirm every other invited account
  // uses; nothing new there.
  @Roles(UserRole.NODE_OPERATOR)
  @Post('nodes/:nodeId/staff/invite')
  @HttpCode(HttpStatus.CREATED)
  inviteStaff(
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() dto: InviteNodeStaffDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    return this.inviteNodeStaffService.invite(user.id, nodeId, dto);
  }

  // Owner-only — business-configuration decision, same bucket as
  // payout-account/staff-invite. Gated to an already-active :nodeId (see
  // SetNodeVisibilityService) since a still-pending Node isn't in search
  // either way.
  @Roles(UserRole.NODE_OPERATOR)
  @Patch('nodes/:nodeId/visibility')
  setVisibility(
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() dto: SetNodeVisibilityDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NodeOperatorResponseDto> {
    return this.setNodeVisibilityService.set(user.id, nodeId, dto);
  }

  // Owner AND staff — operational work at a Node they're a member of, same
  // treatment as handoff scan/confirm. originNodeId is implicit (:nodeId),
  // never a free-typed body field. Reuses payments' own
  // CreatePaymentIntentService/checkout flow end to end — see
  // DispatchParcelService.
  @Roles(UserRole.NODE_OPERATOR, UserRole.NODE_STAFF)
  @Post('nodes/:nodeId/dispatch')
  @HttpCode(HttpStatus.CREATED)
  async dispatch(
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() dto: DispatchParcelDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentIntentResponseDto> {
    const { intent, authorizationUrl } =
      await this.dispatchParcelService.dispatch(user.id, nodeId, dto);
    return PaymentIntentResponseDto.fromEntity(intent, authorizationUrl);
  }

  @Roles(UserRole.ADMIN)
  @Get('pending')
  listPending(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<PendingNodeOperatorResponseDto>> {
    return this.nodeOperatorQueryService.listPending(query);
  }

  @Roles(UserRole.ADMIN)
  @Patch(':id/approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NodeOperatorResponseDto> {
    return this.approveNodeOperatorService.approve(id);
  }
}
