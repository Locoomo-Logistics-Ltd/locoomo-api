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
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { EntityNotFoundException } from '../../../common/exceptions';
import {
  AdminDeliveryRow,
  AdminLogisticsService,
  AdminProviderView,
} from '../application/admin-logistics.service';
import {
  CourierWallet,
  CourierWalletService,
} from '../application/courier-wallet.service';
import {
  EconomicsQueryDto,
  ListDeliveriesQueryDto,
  UpdateLogisticsProviderDto,
  UpdateVehicleRuleDto,
} from './dto/admin-logistics.dto';

@Roles(UserRole.ADMIN)
@Controller('admin/logistics')
export class AdminLogisticsController {
  constructor(
    private readonly adminLogisticsService: AdminLogisticsService,
    private readonly courierWalletService: CourierWalletService,
  ) {}

  @Get('providers')
  listProviders(): Promise<AdminProviderView[]> {
    return this.adminLogisticsService.listProviders();
  }

  @Patch('providers/:key')
  updateProvider(
    @Param('key') key: string,
    @Body() dto: UpdateLogisticsProviderDto,
  ): Promise<AdminProviderView> {
    return this.adminLogisticsService.updateProvider(key, dto);
  }

  @Get('providers/:key/wallet')
  async wallet(@Param('key') key: string): Promise<CourierWallet> {
    const wallet = await this.courierWalletService.walletFor(key);
    if (!wallet) {
      throw new EntityNotFoundException('CourierWallet', key);
    }
    return wallet;
  }

  @Get('vehicle-rules')
  listVehicleRules(): Promise<Record<string, unknown>[]> {
    return this.adminLogisticsService.listVehicleRules();
  }

  @Patch('vehicle-rules/:vehicleClass')
  updateVehicleRule(
    @Param('vehicleClass') vehicleClass: string,
    @Body() dto: UpdateVehicleRuleDto,
  ): Promise<Record<string, unknown>> {
    return this.adminLogisticsService.updateVehicleRule(vehicleClass, dto);
  }

  @Get('deliveries')
  listDeliveries(
    @Query() query: ListDeliveriesQueryDto,
  ): Promise<PaginatedResultDto<AdminDeliveryRow>> {
    return this.adminLogisticsService.listDeliveries(query);
  }

  @Post('deliveries/:id/retry')
  @HttpCode(HttpStatus.OK)
  retry(@Param('id', ParseUUIDPipe) id: string): Promise<AdminDeliveryRow> {
    return this.adminLogisticsService.retry(id);
  }

  @Post('deliveries/:id/fallback')
  @HttpCode(HttpStatus.OK)
  fallback(@Param('id', ParseUUIDPipe) id: string): Promise<AdminDeliveryRow> {
    return this.adminLogisticsService.fallbackToInHouse(id);
  }

  @Post('deliveries/:id/reconcile')
  @HttpCode(HttpStatus.OK)
  reconcile(@Param('id', ParseUUIDPipe) id: string): Promise<AdminDeliveryRow> {
    return this.adminLogisticsService.reconcile(id);
  }

  @Get('economics')
  economics(@Query() query: EconomicsQueryDto) {
    return this.adminLogisticsService.economics(query);
  }
}
