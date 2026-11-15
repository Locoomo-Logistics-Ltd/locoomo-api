import type { MerchantShipmentEntity } from '../infrastructure/entities/merchant-shipment.entity';
import type { ShipmentView } from '../interface/dto/shipment.dto';

// The public Shipment object (MERCHANT_API.md §7.4).
export function shipmentView(
  s: MerchantShipmentEntity,
  trackingUrl: string | null = null,
): ShipmentView {
  return {
    id: s.id,
    mode: s.mode,
    reference: s.reference,
    trackingCode: s.trackingCode,
    // Test codes have no public page (E14); ShipmentPresenter signs live ones.
    trackingUrl: s.mode === 'live' ? trackingUrl : null,
    status: s.status,
    sequence: s.sequence,
    statusChangedAt: s.statusChangedAt.toISOString(),
    origin: {
      type: s.originType,
      nodeId: s.origin.nodeId,
      nodeName: s.origin.nodeName,
    },
    destination: {
      nodeId: s.destination.nodeId,
      nodeName: s.destination.nodeName,
      address: s.destination.address,
      city: s.destination.city,
      state: s.destination.state,
      changed: s.destinationChanged,
    },
    receiver: {
      name: s.receiverName,
      phone: s.receiverPhone,
      email: s.receiverEmail,
    },
    parcel: { ...s.parcel, measured: s.measured },
    externalBarcode: s.externalBarcode,
    manifestId: s.manifestId,
    fee: {
      currency: 'NGN',
      quotedKobo: s.quotedKobo,
      chargedKobo: s.chargedKobo,
      state: s.feeState,
      breakdown: s.feeBreakdown,
    },
    dropDeadline: s.dropDeadline.toISOString(),
    collection: {
      deadline: s.collectionDeadline?.toISOString() ?? null,
      collectedAt: s.collectedAt?.toISOString() ?? null,
      method: s.collectionMethod,
      collectorName: s.collectorName,
    },
    return: s.returnInfo,
    exception: s.exceptionInfo,
    notifyReceiver: s.notifyReceiver,
    metadata: s.metadata,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
