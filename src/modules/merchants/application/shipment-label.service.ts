import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { labelContent, LabelFormat } from '../domain/label';
import { MerchantShipmentEntity } from '../infrastructure/entities/merchant-shipment.entity';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import { LabelRenderer } from '../infrastructure/label-renderer';
import type { MerchantCaller } from './merchant-state';

export interface RenderedLabels {
  pdf: Buffer;
  filename: string;
}

// Shipping labels as PDF (MERCHANT_API.md §9): one, or up to 100 in the
// order asked. Another merchant's or the other mode's shipment is a 404.
@Injectable()
export class ShipmentLabelService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly renderer: LabelRenderer,
  ) {}

  async labels(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    shipmentIds: string[],
    format: LabelFormat,
  ): Promise<RenderedLabels> {
    const ids = [...new Set(shipmentIds)];
    const shipments = await this.dataSource.manager.find(
      MerchantShipmentEntity,
      {
        where: {
          id: In(ids),
          merchantId: caller.merchantId,
          mode: caller.mode,
        },
      },
    );
    const byId = new Map(shipments.map((s) => [s.id, s]));
    const missing = ids.find((id) => !byId.has(id));
    if (missing) {
      throw new EntityNotFoundException('Shipment', missing);
    }
    const merchant = await this.dataSource.manager.findOneByOrFail(
      MerchantEntity,
      { id: caller.merchantId },
    );
    const contents = ids.map((id) => {
      const s = byId.get(id)!;
      return labelContent({
        mode: s.mode,
        trackingCode: s.trackingCode,
        reference: s.reference,
        receiverName: s.receiverName,
        receiverPhone: s.receiverPhone,
        merchantName: merchant.tradingName,
        origin: { nodeName: s.origin.nodeName },
        destination: s.destination,
        parcel: {
          size: s.parcel.size,
          handling: s.parcel.handling,
          weightKg: s.parcel.weightKg,
        },
        createdAt: s.createdAt,
      });
    });
    return {
      pdf: await this.renderer.render(contents, format),
      filename:
        ids.length === 1
          ? `label-${byId.get(ids[0])!.trackingCode}.pdf`
          : `labels-${ids.length}.pdf`,
    };
  }
}
