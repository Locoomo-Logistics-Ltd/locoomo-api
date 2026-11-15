import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import type { RequestWithUser } from '../../../common/auth/auth.guard';
import { RequireAdminPermission } from '../../../common/auth/decorators/require-admin-permission.decorator';
import { auditContextFrom } from '../../../common/audit/audit.service';
import {
  MerchantDiscount,
  MerchantPricingService,
} from '../application/merchant-pricing.service';
import type { DiscountTier } from '../domain/volume-discount';
import { SetDiscountTiersDto, SetMerchantDiscountDto } from './dto/wallet.dto';

const actorFrom = (request: Request) => ({
  userId: (request as RequestWithUser).user!.id,
  context: auditContextFrom(request),
});

// Admin app: volume discount tiers (plan §8.3, F1) and negotiated
// per-merchant discounts. Read by finance/ops/support; changed by finance.
@Controller('admin')
export class AdminMerchantPricingController {
  constructor(private readonly pricing: MerchantPricingService) {}

  @Get('pricing/volume-tiers')
  @RequireAdminPermission(
    AdminPermission.FINANCE,
    AdminPermission.OPS,
    AdminPermission.SUPPORT,
  )
  async tiers(): Promise<{ tiers: DiscountTier[] }> {
    return { tiers: await this.pricing.currentTiers() };
  }

  /** Replaces the tier set from now on (history is kept). */
  @Put('pricing/volume-tiers')
  @RequireAdminPermission(AdminPermission.FINANCE)
  async setTiers(
    @Body() dto: SetDiscountTiersDto,
    @Req() request: Request,
  ): Promise<{ tiers: DiscountTier[] }> {
    return {
      tiers: await this.pricing.setTiers(dto.tiers, actorFrom(request)),
    };
  }

  /** The merchant's live discount this month and how it was reached. */
  @Get('merchants/:id/pricing')
  @RequireAdminPermission(
    AdminPermission.FINANCE,
    AdminPermission.OPS,
    AdminPermission.SUPPORT,
  )
  merchantPricing(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MerchantDiscount> {
    return this.pricing.discountFor(id, 'live');
  }

  /** A negotiated discount replacing the tier (null = back to the tier). */
  @Put('merchants/:id/pricing')
  @RequireAdminPermission(AdminPermission.FINANCE)
  setMerchantPricing(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetMerchantDiscountDto,
    @Req() request: Request,
  ): Promise<MerchantDiscount> {
    return this.pricing.setMerchantDiscount(
      id,
      dto.discountPercent,
      actorFrom(request),
    );
  }
}
