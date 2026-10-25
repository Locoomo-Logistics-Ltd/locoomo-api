// Sendii Partner API v1 wire shapes (https://developers.sendii.ng,
// openapi/partner-v1.json). Money is naira with up to 2 decimals.

export type SendiiStatus =
  | 'pending'
  | 'assigned'
  | 'picked_up'
  | 'delivered'
  | 'returning'
  | 'returned'
  | 'cancelled';

export type SendiiVehicle = 'car' | 'motorbike' | 'bicycle';

export interface SendiiDelivery {
  id: string;
  delivery_id: string | null;
  status: SendiiStatus;
  sequence: number;
  fee: number;
  surcharge: number;
  currency: 'NGN';
  external_ref: string | null;
  rider: { name: string; phone: string; vehicle: SendiiVehicle } | null;
  pickup_code: string | null;
  delivery_code: string | null;
  tracking_code: string | null;
  tracking_url: string | null;
  cancel_reason:
    | 'partner_cancelled'
    | 'no_rider_found'
    | 'sendii_cancelled'
    | 'dispatch_failed'
    | null;
  created_at: string;
  updated_at: string;
  picked_up_at: string | null;
  delivered_at: string | null;
}

export interface SendiiQuote {
  quote_id: string;
  fee: number;
  currency: 'NGN';
  distance_m: number;
  eta_minutes: number;
  expires_at: string;
}

export interface SendiiWallet {
  balance: number;
  held: number;
  available: number;
}

export interface SendiiWebhookEvent {
  webhook_id: string;
  event: string; // 'delivery.assigned' … or 'ping'
  created_at: string;
  livemode: boolean;
  data: SendiiDelivery | { message: string };
}

export type SendiiEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string }; data?: T };
