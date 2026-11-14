import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import type { RequestWithUser } from '../../../common/auth/auth.guard';
import { RequireAdminPermission } from '../../../common/auth/decorators/require-admin-permission.decorator';
import { auditContextFrom } from '../../../common/audit/audit.service';
import { OrderExceptionService } from '../application/order-exception.service';
import { RaiseOrderExceptionDto } from './dto/counter.dto';
import { OrderTransitionResponseDto } from './dto/order-transition-response.dto';

// Admin app › Orders: actions ops take on a parcel in our custody.
@Controller('admin/orders')
@RequireAdminPermission(AdminPermission.OPS)
export class AdminOrdersController {
  constructor(private readonly exceptions: OrderExceptionService) {}

  // Lost or damaged (plan §5.3).
  @Post(':id/exception')
  @HttpCode(HttpStatus.OK)
  async raiseException(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RaiseOrderExceptionDto,
    @Req() request: Request,
  ): Promise<OrderTransitionResponseDto> {
    const order = await this.exceptions.raise(
      id,
      (request as RequestWithUser).user!.id,
      dto,
      auditContextFrom(request),
    );
    return OrderTransitionResponseDto.fromResult(order);
  }
}
