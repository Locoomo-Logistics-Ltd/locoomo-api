import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { FeeBreakdown } from '../domain/fee-breakdown';
import { PricingNotConfiguredException } from '../domain/exceptions/pricing-not-configured.exception';
import { PricingRuleEntity } from '../infrastructure/entities/pricing-rule.entity';

interface NodeCoordinates {
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

  // Distance via PostGIS ST_Distance (meters) on the same geography points
  // NodesService already maintains — no new geo infrastructure needed.
  async calculateFee(
    origin: NodeCoordinates,
    destination: NodeCoordinates,
  ): Promise<FeeBreakdown> {
    const rule = await this.getCurrentRule();

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

    const distanceKm = distanceMeters / 1000;
    const distanceFeeKobo = Math.round(rule.perKmRateKobo * distanceKm);
    const totalKobo = rule.baseFeeKobo + distanceFeeKobo;

    return {
      pricingRuleId: rule.id,
      baseFeeKobo: rule.baseFeeKobo,
      perKmRateKobo: rule.perKmRateKobo,
      distanceKm,
      totalKobo,
    };
  }
}
