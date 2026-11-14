import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { auditContextFrom } from '../../../common/audit/audit.service';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { ApprovalService } from '../application/approval.service';
import {
  ApprovalDecisionDto,
  ApprovalRejectionDto,
  ApprovalResponseDto,
  ListApprovalsQueryDto,
} from './dto/approval.dto';

// Any admin can see the queue; whether they may approve/reject a given
// request is decided per action (its required permission) in the service.
@Controller('admin/approvals')
@Roles(UserRole.ADMIN)
export class AdminApprovalsController {
  constructor(private readonly approvals: ApprovalService) {}

  @Get()
  async list(
    @Query() query: ListApprovalsQueryDto,
  ): Promise<PaginatedResultDto<ApprovalResponseDto>> {
    const result = await this.approvals.list(
      query.status,
      query.page,
      query.limit,
    );
    return new PaginatedResultDto(
      result.items.map((item) => ApprovalResponseDto.from(item)),
      result.page,
      result.limit,
      result.total,
    );
  }

  @Get(':id')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApprovalResponseDto> {
    return ApprovalResponseDto.from(await this.approvals.get(id));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApprovalDecisionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<ApprovalResponseDto> {
    return ApprovalResponseDto.from(
      await this.approvals.approve(
        id,
        user.id,
        dto.note ?? null,
        auditContextFrom(request),
      ),
    );
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApprovalRejectionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<ApprovalResponseDto> {
    return ApprovalResponseDto.from(
      await this.approvals.reject(
        id,
        user.id,
        dto.note,
        auditContextFrom(request),
      ),
    );
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<ApprovalResponseDto> {
    return ApprovalResponseDto.from(
      await this.approvals.cancel(id, user.id, auditContextFrom(request)),
    );
  }
}
