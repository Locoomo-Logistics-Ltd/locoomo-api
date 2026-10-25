import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import type { ParcelDetails } from '../../../common/parcel/parcel-details.dto';
import { LogisticsRouterService } from '../../logistics/application/logistics-router.service';
import { VehicleSelectionService } from '../../logistics/application/vehicle-selection.service';
import { NodesService } from '../../nodes/application/nodes.service';
import { NoDeliveryOptionException } from '../domain/exceptions/no-delivery-option.exception';
import { FeeBreakdown } from '../domain/fee-breakdown';
import { estimateDeliveryMinutes } from '../domain/vehicle-pricing';
import { PricingService } from './pricing.service';

type QuotedNode = Awaited<ReturnType<NodesService['findOne']>>;

export interface DeliveryQuote {
  originNode: QuotedNode;
  destinationNode: QuotedNode;
  feeBreakdown: FeeBreakdown;
  estimatedDeliveryMinutes: number;
}

// What a parcel between two Nodes costs, and whether it can go at all —
// one calculation shared by the price preview and checkout, so the price
// shown is the price charged. Picks the vehicle from the parcel details,
// checks some courier serves that vehicle on this route, then prices it.
@Injectable()
export class DeliveryQuoteService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly nodesService: NodesService,
    private readonly pricingService: PricingService,
    private readonly vehicleSelectionService: VehicleSelectionService,
    private readonly logisticsRouterService: LogisticsRouterService,
  ) {}

  async quote(
    route: { originNodeId: string; destinationNodeId: string },
    parcel: ParcelDetails,
    options: { restrictToPublicNodes?: boolean } = {},
  ): Promise<DeliveryQuote> {
    const originNode = await this.nodesService.findOne(
      route.originNodeId,
      false,
    );
    const destinationNode = await this.nodesService.findOne(
      route.destinationNodeId,
      false,
    );
    // A private Node is hidden from Consumers exactly like a missing one;
    // a Node's own dispatch (restrictToPublicNodes: false) may use them.
    if (options.restrictToPublicNodes ?? true) {
      if (!originNode.isPubliclyVisible) {
        throw new EntityNotFoundException('Node', route.originNodeId);
      }
      if (!destinationNode.isPubliclyVisible) {
        throw new EntityNotFoundException('Node', route.destinationNodeId);
      }
    }

    const vehicleClass = await this.vehicleSelectionService.vehicleFor(parcel);
    if (!vehicleClass) {
      throw new NoDeliveryOptionException(
        'it is larger or heavier than any vehicle we can send',
      );
    }
    const straightLineKm = await this.pricingService.straightLineKm(
      originNode,
      destinationNode,
    );
    const servable = await this.logisticsRouterService.canServe(
      { originNodeId: originNode.id, distanceKm: straightLineKm },
      vehicleClass,
      this.dataSource.manager,
    );
    if (!servable) {
      throw new NoDeliveryOptionException(
        `no courier carries ${vehicleClass} parcels between these stations`,
      );
    }

    const feeBreakdown = await this.pricingService.calculateFee(
      originNode,
      destinationNode,
      vehicleClass,
    );
    return {
      originNode,
      destinationNode,
      feeBreakdown,
      estimatedDeliveryMinutes: estimateDeliveryMinutes(
        feeBreakdown.distanceKm,
      ),
    };
  }
}
