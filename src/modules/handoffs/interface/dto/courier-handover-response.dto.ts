export type CourierHandoverKind = 'pickup' | 'delivery' | 'return_delivery';

// The code staff read out to an external courier. Contains a credential —
// clients must not store, log or cache it.
export class CourierHandoverResponseDto {
  kind!: CourierHandoverKind;
  code!: string;
  courier!: {
    name: string | null;
    phone: string | null;
    vehicle: string | null;
  };
  providerLabel!: string;
  shelfNumber!: number | null;
  trackingCode!: string;
}
