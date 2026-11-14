import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CursorPage,
  decodeOffsetCursor,
  encodeOffsetCursor,
} from '../../../common/pagination/cursor';
import { Env } from '../../../config/env.validation';
import {
  AvailableNode,
  NodesService,
} from '../../nodes/application/nodes.service';
import { DeliveryQuoteService } from '../../payments/application/delivery-quote.service';
import { OriginRequiredException } from '../domain/exceptions/merchant.exceptions';
import {
  estimatedReadyInWorkingDays,
  merchantQuoteAmounts,
} from '../domain/merchant-quote';
import type {
  ListNodesQueryDto,
  MerchantNodeView,
  QuoteQueryDto,
  QuoteView,
} from '../interface/dto/merchant-catalog.dto';

const nodeView = (node: AvailableNode): MerchantNodeView => ({
  id: node.id,
  name: node.name,
  address: node.address,
  city: node.city,
  state: node.state,
  latitude: node.latitude,
  longitude: node.longitude,
  distanceKm: node.distanceKm,
  openingHours: node.openingHours,
  contactPhone: node.contactPhone,
  acceptingParcels: node.acceptingParcels,
});

// The checkout picker (MERCHANT_API.md §6): Nodes a buyer can choose, and
// what a parcel to one costs. Same Nodes in test and live (test shipments
// point at real Nodes but never reach them).
@Injectable()
export class MerchantCatalogService {
  constructor(
    private readonly nodes: NodesService,
    private readonly quotes: DeliveryQuoteService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async listNodes(
    query: ListNodesQueryDto,
  ): Promise<CursorPage<MerchantNodeView>> {
    const offset = decodeOffsetCursor(query.cursor);
    const near = query.near?.split(',').map((part) => Number(part.trim()));
    const rows = await this.nodes.searchAvailable({
      near: near
        ? { latitude: near[0], longitude: near[1], radiusKm: query.radiusKm }
        : undefined,
      q: query.q || undefined,
      state: query.state,
      city: query.city,
      // Capacity is counted per parcel, so any size fits while there's
      // space; parcelSize is accepted now so checkouts can send it already.
      offset,
      limit: query.limit,
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: page.map(nodeView),
      nextCursor: hasMore ? encodeOffsetCursor(offset + page.length) : null,
      hasMore,
    };
  }

  async getNode(id: string): Promise<MerchantNodeView> {
    return nodeView(await this.nodes.getAvailable(id));
  }

  async quote(
    query: QuoteQueryDto,
    options: { hidePrices: boolean },
  ): Promise<QuoteView> {
    // Hubs (the default origin) arrive with M5.
    if (!query.originNodeId) {
      throw new OriginRequiredException();
    }
    const quote = await this.quotes.quote(
      {
        originNodeId: query.originNodeId,
        destinationNodeId: query.destinationNodeId,
      },
      {
        parcelSize: query.parcelSize,
        weightKg: query.weightKg,
        lengthCm: query.lengthCm,
        widthCm: query.widthCm,
        heightCm: query.heightCm,
        handling: query.handling,
      },
    );
    const { amountKobo, breakdown } = merchantQuoteAmounts(quote.feeBreakdown, {
      // Volume discounts arrive with the wallet (M4).
      discountRate: 0,
      vatEnabled: this.config.get('VAT_ENABLED', { infer: true }),
    });
    return {
      currency: 'NGN',
      amountKobo: options.hidePrices ? null : amountKobo,
      breakdown: options.hidePrices ? null : breakdown,
      vehicleClass: quote.feeBreakdown.vehicleClass,
      estimatedReadyInWorkingDays: estimatedReadyInWorkingDays(
        quote.estimatedDeliveryMinutes,
      ),
    };
  }
}
