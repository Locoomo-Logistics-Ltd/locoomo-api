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
import { ApproveRiderService } from '../application/approve-rider.service';
import { GetUploadSignatureService } from '../application/get-upload-signature.service';
import { OnboardRiderService } from '../application/onboard-rider.service';
import { RiderQueryService } from '../application/rider-query.service';
import { SetRiderPayoutAccountService } from '../application/set-rider-payout-account.service';
import { OnboardRiderDto } from './dto/onboard-rider.dto';
import { PendingRiderResponseDto } from './dto/pending-rider-response.dto';
import { RiderResponseDto } from './dto/rider-response.dto';
import { UploadSignatureQueryDto } from './dto/upload-signature-query.dto';
import { UploadSignatureResponseDto } from './dto/upload-signature-response.dto';

@Controller('riders')
export class RidersController {
  constructor(
    private readonly getUploadSignatureService: GetUploadSignatureService,
    private readonly onboardRiderService: OnboardRiderService,
    private readonly approveRiderService: ApproveRiderService,
    private readonly riderQueryService: RiderQueryService,
    private readonly setRiderPayoutAccountService: SetRiderPayoutAccountService,
  ) {}

  @Roles(UserRole.RIDER)
  @Get('verification/upload-signature')
  getUploadSignature(
    @Query() query: UploadSignatureQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): UploadSignatureResponseDto {
    return this.getUploadSignatureService.generate(user.id, query.documentType);
  }

  @Roles(UserRole.RIDER)
  @Post('onboarding')
  @HttpCode(HttpStatus.CREATED)
  onboard(
    @Body() dto: OnboardRiderDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RiderResponseDto> {
    return this.onboardRiderService.onboard(user.id, dto);
  }

  @Roles(UserRole.RIDER)
  @Get('me')
  getMine(@CurrentUser() user: AuthenticatedUser): Promise<RiderResponseDto> {
    return this.riderQueryService.getMine(user.id);
  }

  @Roles(UserRole.RIDER)
  @Patch('me/payout-account')
  setPayoutAccount(
    @Body() dto: SetPayoutAccountDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RiderResponseDto> {
    return this.setRiderPayoutAccountService.set(user.id, dto);
  }

  @Roles(UserRole.ADMIN)
  @Get('pending')
  listPending(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<PendingRiderResponseDto>> {
    return this.riderQueryService.listPending(query);
  }

  @Roles(UserRole.ADMIN)
  @Patch(':id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string): Promise<RiderResponseDto> {
    return this.approveRiderService.approve(id);
  }
}
