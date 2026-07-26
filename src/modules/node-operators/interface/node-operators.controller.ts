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
import { ApproveNodeOperatorService } from '../application/approve-node-operator.service';
import { NodeOperatorQueryService } from '../application/node-operator-query.service';
import { OnboardNodeService } from '../application/onboard-node.service';
import { NodeOperatorResponseDto } from './dto/node-operator-response.dto';
import { OnboardNodeDto } from './dto/onboard-node.dto';
import { PendingNodeOperatorResponseDto } from './dto/pending-node-operator-response.dto';

@Controller('node-operators')
export class NodeOperatorsController {
  constructor(
    private readonly onboardNodeService: OnboardNodeService,
    private readonly approveNodeOperatorService: ApproveNodeOperatorService,
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
  ) {}

  @Roles(UserRole.NODE_OPERATOR)
  @Post('onboarding')
  @HttpCode(HttpStatus.CREATED)
  onboard(
    @Body() dto: OnboardNodeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NodeOperatorResponseDto> {
    return this.onboardNodeService.onboard(user.id, dto);
  }

  @Roles(UserRole.NODE_OPERATOR)
  @Get('me')
  getMine(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NodeOperatorResponseDto> {
    return this.nodeOperatorQueryService.getMine(user.id);
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
