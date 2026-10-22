import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RouteDistanceService } from '../../logistics/application/route-distance.service';
import { FeeBreakdown } from '../domain/fee-breakdown';
import { PricingNotConfiguredException } from '../domain/exceptions/pricing-not-configured.exception';
import { deliveryFeeKobo, rateFor } from '../domain/vehicle-pricing';
import { PricingRuleEntity } from '../infrastructure/entities/pricing-rule.entity';

interface PricedNode {
  id: string;
  latitude: number;
  longitude: number;
}

@Injectable()
export class PricingService {
  constructor(
    @InjectRepository(PricingRuleEntity)
    private readonly pricingRules: Repository<PricingRuleEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly routeDistanceService: RouteDistanceService,
  ) {}

  async getCurrentRule(): Promise<PricingRuleEntity> {
    const rule = await this.pricingRules
      .createQueryBuilder('rule')
      .where('rule.effectiveFrom <= :now', { now: new Date() })
      .orderBy('rule.effectiveFrom', 'DESC')
      .getOne();

    if (!rule) {
      throw new PricingNotConfiguredException();
    }
    return rule;
  }

  async straightLineKm(
    origin: PricedNode,
    destination: PricedNode,
  ): Promise<number> {
    const [{ distanceMeters }] = await this.dataSource.query<
      { distanceMeters: number }[]
    >(
      `SELECT ST_Distance(
         ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
         ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography
       ) AS "distanceMeters"`,
      [
        origin.longitude,
        origin.latitude,
        destination.longitude,
        destination.latitude,
      ],
    );
    return distanceMeters / 1000;
  }

  // Delivery fee for the vehicle the parcel needs over the road distance
  // (a courier-measured one for this Node pair when known, else an
  // estimate from the straight line), plus the destination Node's flat fee.
  async calculateFee(
    origin: PricedNode,
    destination: PricedNode,
    vehicleClass: string,
  ): Promise<FeeBreakdown> {
    const rule = await this.getCurrentRule();
    const straightLineKm = await this.straightLineKm(origin, destination);
    const routeKm = await this.routeDistanceService.roadDistanceKm(
      origin.id,
      destination.id,
    );
    const distanceKm = routeKm ?? straightLineKm * rule.roadDistanceFactor;
    const rate = rateFor(rule, vehicleClass);
    const deliveryFee = deliveryFeeKobo(rate, distanceKm);

    return {
      pricingRuleId: rule.id,
      vehicleClass,
      baseFeeKobo: rate.baseFeeKobo,
      perKmRateKobo: rate.perKmRateKobo,
      distanceKm: Math.round(distanceKm * 100) / 100,
      distanceSource: routeKm !== null ? 'route' : 'estimate',
      straightLineKm: Math.round(straightLineKm * 100) / 100,
      deliveryFeeKobo: deliveryFee,
      destinationFeeKobo: rule.destinationFeeKobo,
      totalKobo: deliveryFee + rule.destinationFeeKobo,
    };
  }
}
