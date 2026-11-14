import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import type { RequestWithUser } from '../../../common/auth/auth.guard';
import { RequireAdminPermission } from '../../../common/auth/decorators/require-admin-permission.decorator';
import { auditContextFrom } from '../../../common/audit/audit.service';
import {
  PublicHolidayService,
  PublicHolidayView,
} from '../application/public-holiday.service';
import {
  AddPublicHolidayDto,
  HolidayDateParam,
  ListPublicHolidaysQueryDto,
} from './dto/public-holiday.dto';

// Admin app › Settings › Public holidays (plan §10 config).
@Controller('admin/public-holidays')
@RequireAdminPermission(AdminPermission.OPS)
export class AdminPublicHolidaysController {
  constructor(private readonly holidays: PublicHolidayService) {}

  @Get()
  list(
    @Query() query: ListPublicHolidaysQueryDto,
  ): Promise<PublicHolidayView[]> {
    return this.holidays.list(query.from);
  }

  @Post()
  add(
    @Body() dto: AddPublicHolidayDto,
    @Req() request: Request,
  ): Promise<PublicHolidayView> {
    return this.holidays.add(
      dto.date,
      dto.name,
      (request as RequestWithUser).user!.id,
      auditContextFrom(request),
    );
  }

  @Delete(':date')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param() params: HolidayDateParam,
    @Req() request: Request,
  ): Promise<void> {
    return this.holidays.remove(
      params.date,
      (request as RequestWithUser).user!.id,
      auditContextFrom(request),
    );
  }
}
