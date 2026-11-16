import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { IsEmail, IsString, Length, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import type { RequestWithUser } from '../../../common/auth/auth.guard';
import { RequireAdminPermission } from '../../../common/auth/decorators/require-admin-permission.decorator';
import { auditContextFrom } from '../../../common/audit/audit.service';
import { PrivacyService } from '../application/privacy.service';

export class SubjectQueryDto {
  /** The receiver's phone (any format we accept), or… */
  @ValidateIf((dto: SubjectQueryDto) => !dto.email)
  @IsString()
  @Length(7, 20)
  phone?: string;

  /** …their email. */
  @ValidateIf((dto: SubjectQueryDto) => !dto.phone)
  @IsEmail()
  email?: string;
}

export class SubjectEraseDto extends SubjectQueryDto {
  /** Why (the request reference), kept in the audit log. */
  @IsString()
  @Length(3, 500)
  reason!: string;
}

// Admin app › Privacy (plan §11.6, M6d): data-subject requests for
// receivers. Super admins only; POST so personal data never sits in a URL.
@Controller('admin/privacy')
@RequireAdminPermission(AdminPermission.SUPER)
export class AdminPrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Post('subject-export')
  @HttpCode(HttpStatus.OK)
  export(@Body() dto: SubjectQueryDto, @Req() request: Request) {
    return this.privacy.exportSubject(
      (request as RequestWithUser).user!.id,
      dto,
      auditContextFrom(request),
    );
  }

  @Post('subject-erase')
  @HttpCode(HttpStatus.OK)
  erase(@Body() dto: SubjectEraseDto, @Req() request: Request) {
    return this.privacy.eraseSubject(
      (request as RequestWithUser).user!.id,
      dto,
      auditContextFrom(request),
    );
  }
}
