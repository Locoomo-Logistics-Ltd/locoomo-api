import { Injectable } from '@nestjs/common';
import { TrackingLinkService } from '../../tracking/application/tracking-link.service';
import type { MerchantShipmentEntity } from '../infrastructure/entities/merchant-shipment.entity';
import type { ShipmentView } from '../interface/dto/shipment.dto';
import { shipmentView } from './shipment-view';

// The Shipment object with its signed public tracking link (live only).
// Links are signed at render time, so rotating TRACKING_LINK_SECRET never
// leaves stale links stored anywhere.
@Injectable()
export class ShipmentPresenter {
  constructor(private readonly links: TrackingLinkService) {}

  view(shipment: MerchantShipmentEntity): ShipmentView {
    return shipmentView(
      shipment,
      shipment.mode === 'live'
        ? this.links.urlFor(shipment.trackingCode)
        : null,
    );
  }
}
