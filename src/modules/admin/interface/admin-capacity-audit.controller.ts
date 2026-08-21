import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { CapacityAuditQueryService } from '../application/capacity-audit-query.service';
import { CapacityAuditResponseDto } from './dto/capacity-audit-response.dto';

@Controller('admin/capacity-audit')
@Roles(UserRole.ADMIN)
export class AdminCapacityAuditController {
  constructor(
    private readonly capacityAuditQueryService: CapacityAuditQueryService,
  ) {}

  @Get()
  async audit(): Promise<CapacityAuditResponseDto> {
    const result = await this.capacityAuditQueryService.audit();
    return CapacityAuditResponseDto.fromResult(result);
  }
}
