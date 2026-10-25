# Logistics API — Frontend Guide

Everything the sender, Node, rider and admin apps need to price, hand over, track and
return parcels — couriers (Sendii) and Locoomo riders alike. Every sample's shape (field
names, nesting, types, which fields can be `null`) is copied from real API responses; the
values (names, ids, amounts, codes) are illustrative.

This guide covers the logistics flows end to end. Auth, users, Node onboarding, payouts
and earnings live in [API.md](API.md), which also carries the full per-endpoint reference.

## Contents

1. [Conventions](#1-conventions)
2. [Concepts in two minutes](#2-concepts-in-two-minutes)
3. [Shared types (TypeScript)](#3-shared-types-typescript)
4. [Sender app](#4-sender-app) — price preview, checkout, orders, returns tab
5. [Node app](#5-node-app) — queues, scan, handovers, collection, returns, own dispatch
6. [Rider app](#6-rider-app-locoomo-riders) — Locoomo riders
7. [Public tracking page](#7-public-tracking-page)
8. [Admin app](#8-admin-app) — couriers, vehicles, pricing, routes, deliveries, money
9. [Error codes](#9-error-codes)
10. [Polling and refresh guidance](#10-polling-and-refresh-guidance)

---

## 1. Conventions

| | |
|---|---|
| Base URL | `{API_ORIGIN}/api/v1` |
| Auth | HttpOnly cookies — send every request with `credentials: 'include'` (see [API.md → CORS and cookies](API.md#cors-and-cookies--read-this-before-writing-any-auth-code)). Only `GET /track/:code` is public. |
| Money | Always integer **kobo** (`₦1 = 100 kobo`): `434400` → `₦4,344.00`. Exception: Admin *inputs* for pricing and alert thresholds are in naira (`…Naira` fields); responses echo both. |
| Time | ISO-8601 UTC strings. Render in the user's local time. |
| Distances | `distanceKm` in km (2 dp), `distanceMeters` in metres. |
| Pagination | `?page=1&limit=20` (`limit` ≤ 100). Lists return `{ items, page, limit, total }`. |
| IDs | UUIDs. Tracking codes look like `LCM-7K3M-Q9TD`. |

Every response uses the same envelope:

```json
{
  "success": true,
  "data": { "…": "endpoint-specific" },
  "meta": { "correlationId": "c4da83ef-0b6d-487e-a511-d07b17e62fc5", "timestamp": "2026-10-25T10:00:00.000Z" }
}
```

```json
{
  "success": false,
  "error": {
    "code": "NO_DELIVERY_OPTION",
    "message": "No delivery option for this parcel: it is larger or heavier than any vehicle we can send",
    "correlationId": "af635b0a-a14c-436d-bdd6-1e62aba27e7a"
  }
}
```

Validation errors add `details`:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "correlationId": "b0c01214-84cc-48f4-8c3e-8f8afac34b1a",
    "details": [
      { "field": "widthCm", "constraint": "max", "message": "widthCm must not be greater than 500" }
    ]
  }
}
```

**Branch on `error.code`, never on `message`.** Messages are for logs and may change.
Show `correlationId` on support/error screens — it's how the backend finds the request.

> All samples below show only `data`; the envelope is omitted for brevity.

---

## 2. Concepts in two minutes

- **Node** (station) — a shop where senders drop parcels and receivers collect them. Each
  order has an **origin** Node and a **destination** Node.
- **Order** — one parcel, origin → destination. Its `status` is the source of truth for
  what happens next.
- **Delivery** (`delivery` on an order) — who is moving the parcel *right now*: an external
  courier (`provider: "sendii"`) or a Locoomo rider (`provider: "in_house"`). The backend
  picks it automatically at drop-off and falls back to Locoomo riders if a courier fails;
  the frontend never chooses.
- **Handover** — every time the parcel changes hands at a counter, a 6-digit code proves
  it. *Who holds the code* depends on `delivery.handover`:
  - `enter_rider_code` — the Locoomo rider shows a code in the rider app; staff type it.
  - `give_code_to_courier` — staff read a code to the external courier, who enters it in
    their own app. The backend learns about it from the courier's webhook.
- **nextAction** — on every Node-app order, the one thing staff at *this* Node should do
  now. Build the counter UI off it rather than off `status`.
- **Returns** — if an external courier can't complete a delivery, it brings the parcel
  back to the **origin** Node and the sender collects it there with an emailed code.
  (Locoomo-rider deliveries have no return path today.)
- **No printers** — senders hand-write the tracking code and destination on the parcel
  (`labelInstructions`), and staff type the code from the parcel (`by-tracking-code`
  forgives case, spaces, a missing `LCM-` and O/0, I/1 mix-ups).

### Order lifecycle

Normal delivery, in order:

| # | `status` | Meaning |
|---|---|---|
| 1 | `awaiting_drop_off` | Paid; the sender is bringing the parcel to the origin Node |
| 2 | `parcel_received_at_origin` | On the origin shelf; a courier is being booked |
| 3 | `rider_assigned` | A courier or rider accepted and is coming to pick up |
| 4 | `in_transit` | Picked up, on the way to the destination Node |
| 5 | `arrived_at_destination` | At the destination Node, being checked in |
| 6 | `ready_for_collection` | Receiver has been emailed a collection code |
| 7 | `completed` | Receiver collected the parcel ✓ |

Return (branches off `in_transit` when the courier can't deliver):

| # | `status` | Meaning |
|---|---|---|
| R1 | `return_initiated` | Delivery failed; the courier will bring it back |
| R2 | `return_in_transit` | Courier is on the way back to the origin Node |
| R3 | `returned_to_origin` | Back at the origin Node, being checked in |
| R4 | `ready_for_sender_collection` | Sender has been emailed a collection code |
| R5 | `return_completed` | Sender collected the parcel ✓ |

Also `cancelled` and `disputed` — set by Admins, never shown on the public page.

---

## 3. Shared types (TypeScript)

Copy these into the frontend. They match the API exactly.

```ts
type Kobo = number;
type ISODate = string;

type OrderStatus =
  | 'awaiting_drop_off' | 'parcel_received_at_origin' | 'rider_assigned' | 'in_transit'
  | 'arrived_at_destination' | 'ready_for_collection' | 'completed'
  | 'return_initiated' | 'return_in_transit' | 'returned_to_origin'
  | 'ready_for_sender_collection' | 'return_completed'
  | 'cancelled' | 'disputed';

type ParcelSize = 'small' | 'medium' | 'large' | 'extra_large';
type HandlingFlag = 'fragile' | 'keep_upright' | 'perishable' | 'liquid';
type VehicleClass = 'bicycle' | 'motorbike' | 'car' | 'van' | 'truck';

// Parcel details as sent at quote/checkout/dispatch. Weight and dimensions are optional;
// dimensions are all-three-or-none. When given, they decide the vehicle (and price).
interface ParcelInput {
  parcelSize: ParcelSize;
  weightKg?: number;      // 0.1 – 1000, max 1 decimal
  lengthCm?: number;      // integer 1 – 500
  widthCm?: number;       // integer 1 – 500
  heightCm?: number;      // integer 1 – 500
  handling?: HandlingFlag[];
}

// Parcel details as returned on orders.
interface Parcel {
  parcelSize: ParcelSize;
  weightKg: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  handling: HandlingFlag[];
  vehicleClass: VehicleClass | null;   // the vehicle class the parcel was priced for
}

interface FeeBreakdown {
  pricingRuleId: string;
  vehicleClass: VehicleClass;
  baseFeeKobo: Kobo;
  perKmRateKobo: Kobo;
  distanceKm: number;
  distanceSource: 'route' | 'estimate';  // measured road distance vs straight line × factor
  straightLineKm: number;
  deliveryFeeKobo: Kobo;
  destinationFeeKobo: Kobo;
  totalKobo: Kobo;
}

type DeliveryLegStatus =
  | 'requested'   // courier being booked / looking for a driver
  | 'assigned'    // a courier/rider is on the way to pick up
  | 'picked_up'   // courier has the parcel
  | 'delivered'   // handed over at the destination  (final)
  | 'returning'   // courier bringing it back to the origin
  | 'returned'    // handed back at the origin       (final)
  | 'cancelled';  // ended before pickup; another delivery usually follows (final)

// `delivery` on order responses: the order's current (or latest) courier leg.
interface Delivery {
  provider: string;                 // 'sendii' | 'in_house' | future couriers — treat as opaque
  providerLabel: string;            // display name: "Sendii", "Locoomo rider"
  type: 'forward' | 'return';
  status: DeliveryLegStatus;
  vehicleClass: VehicleClass | null;
  handover: 'enter_rider_code' | 'give_code_to_courier';
  courier: {
    name: string | null;
    phone?: string | null;          // present for Node staff only, never for senders
    vehicle: string | null;         // free text from the courier, e.g. "Motorbike"
  } | null;                         // null until someone is assigned
  etaMinutes: number | null;
  attemptNumber: number;            // 2+ after a courier failed and was retried/replaced
  updatedAt: ISODate;
}

type NextAction =
  | 'confirm_drop_off' | 'await_courier' | 'hand_to_rider' | 'hand_to_courier'
  | 'await_arrival' | 'receive_from_rider' | 'receive_from_courier' | 'intake'
  | 'hand_to_receiver' | 'return_intake' | 'hand_to_sender' | 'none';

type DayHours = { open: string; close: string }[];   // "HH:mm", Lagos local time
interface OpeningHours {                             // a missing day = closed
  mon?: DayHours; tue?: DayHours; wed?: DayHours; thu?: DayHours;
  fri?: DayHours; sat?: DayHours; sun?: DayHours;
}

// Returned by every counter/rider action endpoint.
interface OrderTransition {
  id: string;
  trackingCode: string;
  status: OrderStatus;
  originNodeId: string;
  destinationNodeId: string;
  shelfNumber: number | null;
}

interface Paginated<T> { items: T[]; page: number; limit: number; total: number; }
```

> **Treat `provider` as opaque.** New couriers will be added without frontend changes;
> display `providerLabel` and switch only on `handover`.

---

## 4. Sender app

### 4.1 Checkout flow

1. `GET /nodes/nearby` — the sender picks the drop-off and collection stations.
2. `GET /delivery-options` — build the parcel form.
3. `POST /delivery-quotes` — show the price; call again whenever an input changes.
4. `POST /payments/intents` — same body plus receiver details → redirect to `authorizationUrl`.
5. Paystack sends the sender back to **`{FRONTEND_URL}/orders/payment-callback?reference=<intentId>`**
   (it also adds `trxref`, with the same value). Read `reference` and poll
   `GET /payments/intents/:id` until it's `paid`.
6. Find the new order (see [after payment](#get-paymentsintentsid--after-the-paystack-redirect))
   and show its label screen.

#### `GET /delivery-options` — build the parcel form

**Any signed-in user.** Cache per session; values change only when an Admin edits vehicle
rules.

Response `200`:

```json
{
  "parcelSizes": ["small", "medium", "large", "extra_large"],
  "handlingFlags": ["fragile", "keep_upright", "perishable", "liquid"],
  "limits": {
    "weightKg": { "min": 0.1, "max": 1000, "decimals": 1 },
    "dimensionCm": { "min": 1, "max": 500 }
  },
  "vehicles": [
    { "vehicleClass": "motorbike", "parcelSizes": ["small", "medium"], "maxWeightKg": 20, "maxLongestSideCm": 60 },
    { "vehicleClass": "car", "parcelSizes": ["small", "medium", "large", "extra_large"], "maxWeightKg": 50, "maxLongestSideCm": 120 }
  ]
}
```

- `limits` — what the API validates (use for input `min`/`max`/`step`).
- `vehicles` — enabled vehicle classes, smallest first. Use for hints like *"Up to 20 kg
  and 60 cm goes by motorbike"*. Anything beyond the last vehicle can't be sent
  (`422 NO_DELIVERY_OPTION` from the quote).

#### `GET /nodes/nearby?latitude=6.5244&longitude=3.3792&radiusKm=10` — pick stations

**Any signed-in user.** Active public Nodes, nearest first. Response `200`:

```json
{
  "items": [
    {
      "id": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
      "name": "Ejigbo Station",
      "address": "12 Ikotun Road, Ejigbo",
      "city": "Lagos",
      "state": "Lagos",
      "country": "Nigeria",
      "latitude": 6.5568,
      "longitude": 3.2846,
      "capacity": 30,
      "status": "active",
      "onboardingType": "portal",
      "operatingHours": null,
      "openingHours": {
        "mon": [{ "open": "08:00", "close": "18:00" }],
        "tue": [{ "open": "08:00", "close": "18:00" }],
        "wed": [{ "open": "08:00", "close": "18:00" }],
        "thu": [{ "open": "08:00", "close": "18:00" }],
        "fri": [{ "open": "08:00", "close": "18:00" }],
        "sat": [{ "open": "09:00", "close": "14:00" }]
      },
      "contactPhone": "+2348031234567",
      "createdAt": "2026-09-02T09:15:00.000Z",
      "distanceMeters": 1840
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

`operatingHours` is a legacy free-text field (usually `null`); display `openingHours`.

#### `POST /delivery-quotes` — price preview

**Consumer, NodeOperator or NodeStaff.** Nothing is reserved. Call it (debounced ~400 ms)
whenever stations or parcel details change. Rate limit: 30/min.

Request:

```json
{
  "originNodeId": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
  "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
  "parcelSize": "small",
  "weightKg": 2.5,
  "lengthCm": 40,
  "widthCm": 30,
  "heightCm": 20,
  "handling": ["fragile"]
}
```

Minimal request — only `parcelSize` is required besides the Nodes:

```json
{
  "originNodeId": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
  "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
  "parcelSize": "small"
}
```

Response `200`:

```json
{
  "amountKobo": 434400,
  "vehicleClass": "motorbike",
  "estimatedDeliveryMinutes": 45,
  "distanceKm": 9.2,
  "feeBreakdown": {
    "pricingRuleId": "b1a5e9a0-5eed-4000-8000-000000000001",
    "vehicleClass": "motorbike",
    "baseFeeKobo": 110000,
    "perKmRateKobo": 32000,
    "distanceKm": 9.2,
    "distanceSource": "route",
    "straightLineKm": 6.4,
    "deliveryFeeKobo": 404400,
    "destinationFeeKobo": 30000,
    "totalKobo": 434400
  },
  "validUntil": "2026-10-25T10:15:00.000Z"
}
```

UI notes:
- Show `amountKobo` as the price — it's exactly what checkout charges for the same inputs.
- Show `vehicleClass` (*"Goes by motorbike"*) and `estimatedDeliveryMinutes` as approximate
  (*"about 45 min after drop-off"*).
- Re-quote after `validUntil`, or before submitting if the screen sat idle.
- A bigger parcel switches to `"car"` and the price jumps — expected; make it visible.

Errors: `400 VALIDATION_FAILED`, `404 NOT_FOUND` (Node missing/inactive/private),
`422 NO_DELIVERY_OPTION` (*"This parcel is too big or heavy for our vehicles — try
different details or another station"*), `429 RATE_LIMITED`,
`503 PRICING_NOT_CONFIGURED`.

#### `POST /payments/intents` — place the order

**Consumer.** The quote body plus receiver details. Holds a slot at the origin Node for
~15 min and returns the Paystack checkout URL. Rate limit: 5/min.

Request:

```json
{
  "originNodeId": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
  "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
  "receiverFullName": "Tunde Bakare",
  "receiverEmail": "tunde.bakare@example.com",
  "receiverPhone": "+2348012345678",
  "parcelDescription": "Two pairs of shoes in a shoebox",
  "parcelSize": "small",
  "weightKg": 2.5,
  "lengthCm": 40,
  "widthCm": 30,
  "heightCm": 20,
  "handling": ["fragile"]
}
```

Field rules: `receiverFullName` 1–100 chars; `receiverPhone` matches `^\+?[0-9]{7,15}$`;
`parcelDescription` 1–500 chars.

Response `201`:

```json
{
  "id": "e2a95c3b-1f7d-4b8e-a6c0-5d3f9e1b7a22",
  "originNodeId": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
  "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
  "receiverFullName": "Tunde Bakare",
  "receiverEmail": "tunde.bakare@example.com",
  "receiverPhone": "+2348012345678",
  "parcelDescription": "Two pairs of shoes in a shoebox",
  "parcelSize": "small",
  "parcel": {
    "parcelSize": "small",
    "weightKg": 2.5,
    "lengthCm": 40,
    "widthCm": 30,
    "heightCm": 20,
    "handling": ["fragile"],
    "vehicleClass": "motorbike"
  },
  "feeBreakdown": {
    "pricingRuleId": "b1a5e9a0-5eed-4000-8000-000000000001",
    "vehicleClass": "motorbike",
    "baseFeeKobo": 110000,
    "perKmRateKobo": 32000,
    "distanceKm": 9.2,
    "distanceSource": "route",
    "straightLineKm": 6.4,
    "deliveryFeeKobo": 404400,
    "destinationFeeKobo": 30000,
    "totalKobo": 434400
  },
  "amountKobo": 434400,
  "status": "pending",
  "expiresAt": "2026-10-25T10:15:00.000Z",
  "authorizationUrl": "https://checkout.paystack.com/abc123xyz"
}
```

Redirect the browser to `authorizationUrl` (single use).

Errors: `404 NOT_FOUND` (Node), `409 NODE_CAPACITY_UNAVAILABLE` (*"This station is full
right now — pick another"*), `422 NO_DELIVERY_OPTION`, `429 RATE_LIMITED`,
`503 PRICING_NOT_CONFIGURED`.

#### `GET /payments/intents/:id` — after the Paystack redirect

**Consumer (own intents).** `:id` is the `reference` query parameter on the callback URL.
Response `200`: the same shape as the create response, without `authorizationUrl`:

```json
{
  "id": "e2a95c3b-1f7d-4b8e-a6c0-5d3f9e1b7a22",
  "originNodeId": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
  "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
  "receiverFullName": "Tunde Bakare",
  "receiverEmail": "tunde.bakare@example.com",
  "receiverPhone": "+2348012345678",
  "parcelDescription": "Two pairs of shoes in a shoebox",
  "parcelSize": "small",
  "parcel": {
    "parcelSize": "small",
    "weightKg": 2.5,
    "lengthCm": 40,
    "widthCm": 30,
    "heightCm": 20,
    "handling": ["fragile"],
    "vehicleClass": "motorbike"
  },
  "feeBreakdown": {
    "pricingRuleId": "b1a5e9a0-5eed-4000-8000-000000000001",
    "vehicleClass": "motorbike",
    "baseFeeKobo": 110000,
    "perKmRateKobo": 32000,
    "distanceKm": 9.2,
    "distanceSource": "route",
    "straightLineKm": 6.4,
    "deliveryFeeKobo": 404400,
    "destinationFeeKobo": 30000,
    "totalKobo": 434400
  },
  "amountKobo": 434400,
  "status": "paid",
  "expiresAt": "2026-10-25T10:15:00.000Z"
}
```

| `status` | Show |
|---|---|
| `pending` | *"Confirming your payment…"* — keep polling (every 2 s, up to ~2 min) |
| `paid` | Success → open the order |
| `failed` | *"Payment didn't go through"* → back to checkout |
| `expired` | *"Your checkout timed out"* → back to checkout (the station slot was released) |

The intent doesn't carry the order id. Once `paid`, fetch `GET /orders?limit=5` and pick
the item whose `paymentIntentId` equals the intent id (the newest order, in practice).

### 4.2 My orders

#### `GET /orders?status=…&page=1&limit=20`

**Consumer.** Newest first. `status` is optional and comma-separated:

| Tab | Query |
|---|---|
| Active | `?status=awaiting_drop_off,parcel_received_at_origin,rider_assigned,in_transit,arrived_at_destination,ready_for_collection` |
| Delivered | `?status=completed` |
| Returns | `?status=return_initiated,return_in_transit,returned_to_origin,ready_for_sender_collection,return_completed` |
| All | *(omit)* |

Response `200` — `Paginated<Order>`; each item has exactly the
[`GET /orders/:id`](#get-ordersid--order-details) shape:

```json
{ "items": [ { "…": "Order" } ], "page": 1, "limit": 20, "total": 1 }
```

An unknown status → `400 VALIDATION_FAILED` listing the allowed values.

#### `GET /orders/:id` — order details

**Consumer (own orders).** Response `200`:

```json
{
  "id": "3f6c2a1e-8b4d-4e2a-9c7f-1d5e8a2b4c60",
  "trackingCode": "LCM-7K3M-Q9TD",
  "paymentIntentId": "e2a95c3b-1f7d-4b8e-a6c0-5d3f9e1b7a22",
  "originNodeId": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
  "originNodeName": "Ejigbo Station",
  "originNodeAddress": "12 Ikotun Road, Ejigbo",
  "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
  "destinationNodeName": "Pedro Road Station",
  "destinationNodeAddress": "45 Pedro Road, Shomolu",
  "receiverFullName": "Tunde Bakare",
  "receiverEmail": "tunde.bakare@example.com",
  "receiverPhone": "+2348012345678",
  "parcelDescription": "Two pairs of shoes in a shoebox",
  "parcelSize": "small",
  "parcel": {
    "parcelSize": "small",
    "weightKg": 2.5,
    "lengthCm": 40,
    "widthCm": 30,
    "heightCm": 20,
    "handling": ["fragile"],
    "vehicleClass": "motorbike"
  },
  "amountKobo": 434400,
  "status": "rider_assigned",
  "createdAt": "2026-10-25T09:58:12.000Z",
  "trackingUrl": "https://app.locoomo.com/track/LCM-7K3M-Q9TD?t=vH7-s18f1JP91ZfyVjm7Nq",
  "labelInstructions": {
    "lines": ["LCM-7K3M-Q9TD", "TO: PEDRO ROAD STATION"],
    "note": "Write this clearly on the parcel with a marker before drop-off."
  },
  "delivery": {
    "provider": "sendii",
    "providerLabel": "Sendii",
    "type": "forward",
    "status": "assigned",
    "vehicleClass": "motorbike",
    "handover": "give_code_to_courier",
    "courier": { "name": "Musa A.", "vehicle": "Motorbike" },
    "etaMinutes": 25,
    "attemptNumber": 1,
    "updatedAt": "2026-10-25T10:20:41.000Z"
  }
}
```

UI notes:
- **Label screen** (status `awaiting_drop_off`): show `labelInstructions.lines` large, in
  monospace, one per line, plus `note`. That's what the sender writes on the parcel.
- **Share tracking**: `trackingUrl` is the public page link including its access token —
  share it as is (copy, WhatsApp, …).
- `delivery` is `null` until the parcel is dropped off. Senders never get the courier's
  phone (`courier.phone` is omitted for them).
- On a return, the parcel goes back to the **origin** station — use `originNodeName` /
  `originNodeAddress` for *"Collect your parcel from …"*.

#### `GET /orders/:id/timeline` — history

**Consumer (own orders).** Response `200`, oldest first:

```json
[
  { "status": "order_placed", "label": "Order placed", "at": "2026-10-25T09:58:12.000Z" },
  { "status": "at_origin_station", "label": "Dropped off at Ejigbo Station", "at": "2026-10-25T10:12:03.000Z" },
  { "status": "at_origin_station", "label": "Rider assigned", "at": "2026-10-25T10:20:41.000Z" },
  { "status": "on_the_way", "label": "On the way to Pedro Road Station", "at": "2026-10-25T10:34:10.000Z" }
]
```

`status` uses the [public status vocabulary](#public-statuses); render `label` as is.

---

## 5. Node app

**NodeOperator or NodeStaff.** Everything is scoped to the caller's Node(s); another
Node's orders return `404`.

### 5.1 The counter loop

1. Staff type or scan the code on the parcel → `GET /handoffs/orders/by-tracking-code/:code`.
2. Read `nextAction` → show exactly one primary button.
3. Call the action endpoint → refresh the order.

| `nextAction` | Side | What staff do | Call |
|---|---|---|---|
| `confirm_drop_off` | origin | Sender hands the parcel in; check the hand-written label | `POST /handoffs/orders/:id/drop-off` |
| `await_courier` | origin | Nothing — a courier is being booked. Parcel stays on shelf `shelfNumber` | poll |
| `hand_to_rider` | origin | Locoomo rider shows a code → staff type it | `POST /handoffs/orders/:id/confirm-handoff` `{ "type": "rider_pickup" }` |
| `hand_to_courier` | origin | Read the code to the external courier | `GET /handoffs/orders/:id/courier-handover`, then poll |
| `await_arrival` | destination; origin on a return | Nothing — the parcel is on its way here | poll / `incoming` queue |
| `receive_from_rider` | destination | Locoomo rider shows a code → staff type it | `POST …/confirm-handoff` `{ "type": "rider_arrival" }` |
| `receive_from_courier` | destination; origin on a return | Read the code to the courier | `GET …/courier-handover`, then poll |
| `intake` | destination | Check the parcel in; receiver gets a code by email | `POST /handoffs/orders/:id/intake` |
| `hand_to_receiver` | destination | Receiver shows their emailed code + ID | `POST /handoffs/orders/:id/collect` |
| `return_intake` | origin | Check the returned parcel in; sender gets a code | `POST /handoffs/orders/:id/return-intake` |
| `hand_to_sender` | origin | Sender shows their emailed code + ID | `POST /handoffs/orders/:id/return-collect` |
| `none` | — | Nothing to do here (finished, or not this Node's turn) | — |

### 5.2 Work queues — `GET /handoffs/my-node/orders?queue=…`

| `queue` | Shows |
|---|---|
| `to_receive` | Paid parcels the sender hasn't dropped off yet (origin) |
| `to_dispatch` | On the origin shelf, waiting for / being handed to a courier |
| `incoming` | Heading here — deliveries, and returns coming back |
| `to_collect` | Waiting for the receiver (or, on returns, the sender) to collect |
| *(omitted)* | Full history of every order that touched the caller's Nodes |

Response `200`:

```json
{
  "items": [
    {
      "id": "3f6c2a1e-8b4d-4e2a-9c7f-1d5e8a2b4c60",
      "trackingCode": "LCM-7K3M-Q9TD",
      "status": "in_transit",
      "originNodeId": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
      "originNodeName": "Ejigbo Station",
      "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
      "destinationNodeName": "Pedro Road Station",
      "parcelDescription": "Two pairs of shoes in a shoebox",
      "parcelSize": "small",
      "parcel": {
        "parcelSize": "small",
        "weightKg": 2.5,
        "lengthCm": 40,
        "widthCm": 30,
        "heightCm": 20,
        "handling": ["fragile"],
        "vehicleClass": "motorbike"
      },
      "createdAt": "2026-10-25T09:58:12.000Z",
      "myRole": "destination",
      "nextAction": "receive_from_courier",
      "shelfNumber": null,
      "receiverMasked": "T. B. · ***5678",
      "delivery": {
        "provider": "sendii",
        "providerLabel": "Sendii",
        "type": "forward",
        "status": "picked_up",
        "vehicleClass": "motorbike",
        "handover": "give_code_to_courier",
        "courier": { "name": "Musa A.", "phone": "+2348031112222", "vehicle": "Motorbike" },
        "etaMinutes": 18,
        "attemptNumber": 1,
        "updatedAt": "2026-10-25T10:34:10.000Z"
      }
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

- `myRole` — which side this Node plays for the order (`origin` | `destination`).
- `shelfNumber` — where the parcel sits on *this* Node's shelf; `null` when it isn't on a
  shelf here. Show it big — staff write it on the parcel at drop-off/intake.
- `receiverMasked` — enough to match a person at the counter without full details.
- Node staff **do** see `courier.phone` (to call a late courier).
- `delivery` is `null` before drop-off.

Bad `queue` → `400 VALIDATION_FAILED`.

### 5.3 Scan — `GET /handoffs/orders/by-tracking-code/:code`

Accepts sloppy input: `lcm 7k3m q9td`, `7K3MQ9TD` and `LCM-7K3M-Q9TO` all find
`LCM-7K3M-Q9TD`. Response `200` — same shape as a queue item:

```json
{
  "id": "3f6c2a1e-8b4d-4e2a-9c7f-1d5e8a2b4c60",
  "trackingCode": "LCM-7K3M-Q9TD",
  "status": "rider_assigned",
  "originNodeId": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
  "originNodeName": "Ejigbo Station",
  "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
  "destinationNodeName": "Pedro Road Station",
  "parcelDescription": "Two pairs of shoes in a shoebox",
  "parcelSize": "small",
  "parcel": {
    "parcelSize": "small",
    "weightKg": 2.5,
    "lengthCm": 40,
    "widthCm": 30,
    "heightCm": 20,
    "handling": ["fragile"],
    "vehicleClass": "motorbike"
  },
  "createdAt": "2026-10-25T09:58:12.000Z",
  "myRole": "origin",
  "nextAction": "hand_to_courier",
  "shelfNumber": 2,
  "receiverMasked": "T. B. · ***5678",
  "delivery": {
    "provider": "sendii",
    "providerLabel": "Sendii",
    "type": "forward",
    "status": "assigned",
    "vehicleClass": "motorbike",
    "handover": "give_code_to_courier",
    "courier": { "name": "Musa A.", "phone": "+2348031112222", "vehicle": "Motorbike" },
    "etaMinutes": 25,
    "attemptNumber": 1,
    "updatedAt": "2026-10-25T10:20:41.000Z"
  }
}
```

Errors: `404 NOT_FOUND` (no such parcel, input can't be a code, or another Node's parcel)
→ *"No parcel with that code at this station"*.

Show `parcel.handling` as warning chips (Fragile, Keep upright, …) on every counter screen.

### 5.4 Drop-off — `POST /handoffs/orders/:id/drop-off`

No body. Safe to repeat. Response `200` — an `OrderTransition`, the short shape every
action endpoint returns:

```json
{
  "id": "3f6c2a1e-8b4d-4e2a-9c7f-1d5e8a2b4c60",
  "trackingCode": "LCM-7K3M-Q9TD",
  "status": "parcel_received_at_origin",
  "originNodeId": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
  "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
  "shelfNumber": 10
}
```

Show *"Put it on shelf **10**"*. The courier is booked in the background; the order moves
to `rider_assigned` (`nextAction: hand_to_courier` or `hand_to_rider`) once someone accepts.

### 5.5 Handover to/from an external courier — `GET /handoffs/orders/:id/courier-handover`

When `nextAction` is `hand_to_courier` or `receive_from_courier`. Rate limit: 20/min.

Response `200`:

```json
{
  "kind": "pickup",
  "code": "481920",
  "courier": { "name": "Musa A.", "phone": "+2348031112222", "vehicle": "motorbike" },
  "providerLabel": "Sendii",
  "shelfNumber": 2,
  "trackingCode": "LCM-7K3M-Q9TD"
}
```

| `kind` | When | Screen copy |
|---|---|---|
| `pickup` | origin, courier collecting | *"Give the parcel on shelf 2 to Musa A. (Sendii). Read them this code: 481 920"* |
| `delivery` | destination, courier arriving | *"Musa A. is delivering LCM-7K3M-Q9TD. Read them this code: 552 107"* |
| `return_delivery` | origin, courier bringing a failed delivery back | *"Musa A. is returning LCM-7K3M-Q9TD. Read them this code: …"* |

Then **poll `by-tracking-code` every 3–5 s** until `nextAction` changes (the courier entered
the code; the backend hears via webhook). Stop after ~10 min and offer **Refresh**.

- `code` is a credential: show it on screen, but never log, cache or persist it.
- Any `courier` field can be `null` (the courier didn't share it).

Errors: `409 COURIER_HANDOVER_NOT_AVAILABLE` (nothing to hand over right now — re-scan),
`502 LOGISTICS_PROVIDER_ERROR` (courier unreachable — *"Try again in a moment"*),
`404 NOT_FOUND`.

### 5.6 Handover to/from a Locoomo rider — `POST /handoffs/orders/:id/confirm-handoff`

When `nextAction` is `hand_to_rider` (pickup) or `receive_from_rider` (arrival). The rider
shows a 6-digit code from their app; staff type it. Rate limit: 10/min.

Request:

```json
{ "type": "rider_pickup", "code": "948212" }
```

`type` is `rider_pickup` at the origin, `rider_arrival` at the destination. Response
`200`: an `OrderTransition` with the new `status` (`in_transit` after a pickup,
`arrived_at_destination` after an arrival).

Errors: `401 INVALID_HANDOFF_CODE` — wrong or expired code. Codes last 5 min; after 5
wrong tries the code is locked and the rider must generate a new one. Show *"Code didn't
match — ask the rider for a fresh code"*.

### 5.7 Intake at the destination — `POST /handoffs/orders/:id/intake`

No body. Safe to repeat. Emails the receiver a collection code (valid 60 min). Response
`200`:

```json
{
  "id": "3f6c2a1e-8b4d-4e2a-9c7f-1d5e8a2b4c60",
  "trackingCode": "LCM-7K3M-Q9TD",
  "status": "ready_for_collection",
  "originNodeId": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
  "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
  "shelfNumber": 4
}
```

### 5.8 Hand to the receiver — `POST /handoffs/orders/:id/collect`

The receiver shows the emailed code; staff confirm they checked the name/ID. Rate limit:
10/min.

Request:

```json
{ "code": "274697", "identityConfirmed": true }
```

Response `200`: an `OrderTransition` with `"status": "completed"` and `"shelfNumber": null`.

Errors: `401 INVALID_HANDOFF_CODE` (wrong, expired or locked — offer **Resend code**).

#### Resend the code — `POST /handoffs/orders/:id/collection-code/resend`

No body. Rate limit: 5/min. Works for the receiver (`ready_for_collection`) and, on
returns, the sender (`ready_for_sender_collection`). The new code replaces the old one.
Response `200`:

```json
{ "expiresAt": "2026-10-25T11:13:30.000Z" }
```

The code itself is only emailed, never returned. Error: `409 ORDER_NOT_READY_FOR_COLLECTION`.

### 5.9 Returns at the origin Node

1. `nextAction: await_arrival`, then `receive_from_courier` — the courier is bringing the
   parcel back. Read them the code from `courier-handover`, which answers with
   `kind: "return_delivery"`, then poll as in [5.5](#55-handover-tofrom-an-external-courier--get-handoffsordersidcourier-handover).
2. `return_intake` → `POST /handoffs/orders/:id/return-intake` (no body). Emails the
   sender a collection code (valid 60 min). Response `200`:

   ```json
   {
     "id": "3f6c2a1e-8b4d-4e2a-9c7f-1d5e8a2b4c60",
     "trackingCode": "LCM-7K3M-Q9TD",
     "status": "ready_for_sender_collection",
     "originNodeId": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
     "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
     "shelfNumber": 8
   }
   ```

3. `hand_to_sender` → `POST /handoffs/orders/:id/return-collect` with the same body as
   `collect` (rate limit 10/min):

   ```json
   { "code": "840814", "identityConfirmed": true }
   ```

   Response `200`: an `OrderTransition` with `"status": "return_completed"`.

### 5.10 A Node's own dispatch — `POST /node-operators/nodes/:nodeId/dispatch`

Node staff sending a parcel *from their own Node* (may target private Nodes). Quote first
with `POST /delivery-quotes` (staff may quote their own private Nodes). Body = the
checkout body without `originNodeId`:

```json
{
  "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
  "receiverFullName": "Tunde Bakare",
  "receiverEmail": "tunde.bakare@example.com",
  "receiverPhone": "+2348012345678",
  "parcelDescription": "Replacement phone screen",
  "parcelSize": "small"
}
```

Response `201`: same shape as `POST /payments/intents` (redirect to `authorizationUrl`).
Errors: `403 NODE_NOT_ACTIVE` (station not approved yet), `404 NOT_FOUND`,
`422 NO_DELIVERY_OPTION`.

---

## 6. Rider app (Locoomo riders)

**Rider (approved).** Riders only see parcels that no external courier is handling.

#### `GET /handoffs/available-orders?latitude=6.5244&longitude=3.3792`

Unclaimed parcels at origin Nodes, nearest first. Response `200`:

```json
{
  "items": [
    {
      "id": "3f6c2a1e-8b4d-4e2a-9c7f-1d5e8a2b4c60",
      "trackingCode": "LCM-7K3M-Q9TD",
      "originNodeId": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
      "originNodeName": "Ejigbo Station",
      "originNodeAddress": "12 Ikotun Road, Ejigbo",
      "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
      "destinationNodeName": "Pedro Road Station",
      "destinationNodeAddress": "45 Pedro Road, Shomolu",
      "parcelDescription": "Two pairs of shoes in a shoebox",
      "parcelSize": "small",
      "createdAt": "2026-10-25T09:58:12.000Z",
      "distanceMeters": 2300
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

#### `POST /handoffs/orders/:id/accept`

No body. Response `200`: an `OrderTransition` with `"status": "rider_assigned"`.

Errors: `409 ILLEGAL_ORDER_TRANSITION` (someone else took it — refresh the list),
`409 RIDER_CAPACITY_UNAVAILABLE` (at the active-delivery limit),
`403 RIDER_NOT_ACTIVE` (not approved yet).

#### `GET /handoffs/my-orders`

The rider's deliveries, active and past. Response `200`:

```json
{
  "items": [
    {
      "id": "3f6c2a1e-8b4d-4e2a-9c7f-1d5e8a2b4c60",
      "trackingCode": "LCM-7K3M-Q9TD",
      "status": "in_transit",
      "originNodeId": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
      "originNodeName": "Ejigbo Station",
      "originNodeAddress": "12 Ikotun Road, Ejigbo",
      "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
      "destinationNodeName": "Pedro Road Station",
      "destinationNodeAddress": "45 Pedro Road, Shomolu",
      "parcelDescription": "Two pairs of shoes in a shoebox",
      "parcelSize": "small",
      "createdAt": "2026-10-25T09:58:12.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

#### `POST /handoffs/orders/:id/request-code` — show a code at the counter

Request:

```json
{ "type": "rider_pickup" }
```

`rider_pickup` at the origin (status `rider_assigned`); `rider_arrival` at the destination
(status `in_transit`). Response `201`:

```json
{ "code": "948212", "expiresAt": "2026-10-25T10:17:29.000Z" }
```

Show the code large with a countdown to `expiresAt` (5 min) and a **New code** button.
Staff type it into `confirm-handoff`.

---

## 7. Public tracking page

**No auth.** Web route `/track/:trackingCode`. Rate limit: 10/min per IP.

#### `GET /track/:trackingCode?t=<token>` or `?phoneLast4=5678`

Send **exactly one** of:
- `t` — the token from the tracking link (`trackingUrl` and emails). Read it off the page URL.
- `phoneLast4` — the last 4 digits of the receiver's phone, for someone who only has the
  code off the parcel. Form: *tracking code + last 4 digits of the receiver's phone*.

Response `200` (in progress):

```json
{
  "trackingCode": "LCM-7K3M-Q9TD",
  "status": "on_the_way",
  "statusLabel": "On the way",
  "isFinal": false,
  "timeline": [
    { "status": "order_placed", "label": "Order placed", "at": "2026-10-25T09:58:12.000Z" },
    { "status": "at_origin_station", "label": "Dropped off at Ejigbo Station", "at": "2026-10-25T10:12:03.000Z" },
    { "status": "at_origin_station", "label": "Rider assigned", "at": "2026-10-25T10:20:41.000Z" },
    { "status": "on_the_way", "label": "On the way to Pedro Road Station", "at": "2026-10-25T10:34:10.000Z" }
  ],
  "origin": { "name": "Ejigbo Station", "city": "Lagos" },
  "destination": {
    "name": "Pedro Road Station",
    "address": "45 Pedro Road, Shomolu",
    "city": "Lagos",
    "state": "Lagos",
    "openingHours": {
      "mon": [{ "open": "08:00", "close": "18:00" }],
      "tue": [{ "open": "08:00", "close": "18:00" }],
      "wed": [{ "open": "08:00", "close": "18:00" }],
      "thu": [{ "open": "08:00", "close": "18:00" }],
      "fri": [{ "open": "08:00", "close": "18:00" }],
      "sat": [{ "open": "09:00", "close": "14:00" }]
    }
  },
  "courierLabel": "Sendii",
  "etaMinutes": 18,
  "nextStep": "The parcel is on its way to Pedro Road Station. We'll email the receiver a collection code when it's ready.",
  "updatedAt": "2026-10-25T10:34:10.000Z"
}
```

Response `200` (returned to sender) — `origin` gains `address`, `state` and
`openingHours`, because that's where the parcel is now (`openingHours` trimmed to one day
here for brevity):

```json
{
  "trackingCode": "LCM-7K3M-Q9TD",
  "status": "return_completed",
  "statusLabel": "Returned to sender",
  "isFinal": true,
  "timeline": [
    { "status": "order_placed", "label": "Order placed", "at": "2026-10-25T09:58:12.000Z" },
    { "status": "at_origin_station", "label": "Dropped off at Ejigbo Station", "at": "2026-10-25T10:12:03.000Z" },
    { "status": "on_the_way", "label": "On the way to Pedro Road Station", "at": "2026-10-25T10:34:10.000Z" },
    { "status": "returning_to_sender", "label": "Delivery couldn't be completed", "at": "2026-10-25T11:05:00.000Z" },
    { "status": "returning_to_sender", "label": "Returning to Ejigbo Station", "at": "2026-10-25T11:05:00.000Z" },
    { "status": "returned_to_sender", "label": "Back at Ejigbo Station", "at": "2026-10-25T11:40:00.000Z" },
    { "status": "returned_to_sender", "label": "Ready for the sender to collect", "at": "2026-10-25T11:41:00.000Z" },
    { "status": "return_completed", "label": "Collected by the sender", "at": "2026-10-25T15:02:00.000Z" }
  ],
  "origin": {
    "name": "Ejigbo Station",
    "city": "Lagos",
    "address": "12 Ikotun Road, Ejigbo",
    "state": "Lagos",
    "openingHours": { "mon": [{ "open": "08:00", "close": "18:00" }] }
  },
  "destination": {
    "name": "Pedro Road Station",
    "address": "45 Pedro Road, Shomolu",
    "city": "Lagos",
    "state": "Lagos",
    "openingHours": { "mon": [{ "open": "08:00", "close": "18:00" }] }
  },
  "courierLabel": null,
  "etaMinutes": null,
  "nextStep": "The sender has collected the parcel.",
  "updatedAt": "2026-10-25T15:02:00.000Z"
}
```

The page deliberately carries no names, phones, codes or prices. Render `statusLabel`,
`nextStep` and the timeline `label`s verbatim. When `isFinal` is `true`, stop polling.

<a id="public-statuses"></a>**Public statuses** (`status`, and timeline `status`):

| `status` | `statusLabel` | Progress step |
|---|---|---|
| `awaiting_drop_off` | Awaiting drop-off | 1 |
| `at_origin_station` | At origin station | 2 |
| `on_the_way` | On the way | 3 |
| `arrived_at_destination` | Arrived at destination station | 4 |
| `ready_for_collection` | Ready for collection | 4 |
| `collected` | Collected | 5 ✓ |
| `returning_to_sender` | Returning to sender | return track |
| `returned_to_sender` | Returned — ready for sender collection | return track |
| `return_completed` | Returned to sender | return track ✓ |

(`order_placed` appears only in timelines.)

Errors: `400 VALIDATION_FAILED` (sent both or neither of `t` / `phoneLast4`), and
**`404 NOT_FOUND` for every other failure** — wrong code, token or digits, or more than
30 days after collection. Show one generic message: *"We couldn't find that parcel. Check
the code and the last 4 digits."*

---

## 8. Admin app

**Admin only.** Paths are under `/admin/logistics` unless stated.

### 8.1 Couriers

#### `GET /admin/logistics/providers`

```json
[
  {
    "key": "sendii",
    "label": "Sendii",
    "enabled": true,
    "priority": 10,
    "maxAttempts": 2,
    "assignTimeoutMinutes": 20,
    "minDistanceKm": 0.1,
    "maxDistanceKm": 80,
    "pilotNodeIds": ["7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38", "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94"],
    "maxCostShare": 0.75,
    "lowBalanceAlertKobo": 5000000,
    "activeDeliveries": 7,
    "registered": true,
    "capabilities": {
      "vehicleClasses": ["motorbike", "car"],
      "handover": "provider_code",
      "updates": "webhook",
      "prepaidWallet": true
    }
  },
  {
    "key": "in_house",
    "label": "Locoomo rider",
    "enabled": true,
    "priority": 1000,
    "maxAttempts": 1,
    "assignTimeoutMinutes": null,
    "minDistanceKm": null,
    "maxDistanceKm": null,
    "pilotNodeIds": null,
    "maxCostShare": null,
    "lowBalanceAlertKobo": null,
    "activeDeliveries": 32,
    "registered": true,
    "capabilities": {
      "vehicleClasses": ["bicycle", "motorbike", "car"],
      "handover": "locoomo_code",
      "updates": "internal",
      "prepaidWallet": false
    }
  }
]
```

| Field | Meaning (form help text) |
|---|---|
| `enabled` | Courier receives new jobs. `in_house` can't be switched off. |
| `priority` | Lower is tried first. Locoomo riders (1000) are always the fallback. |
| `maxAttempts` | Bookings tried with this courier per order before falling back. |
| `assignTimeoutMinutes` | Give up if no driver accepts within this time. `null` = wait indefinitely. |
| `minDistanceKm` / `maxDistanceKm` | Only route orders within this road distance. `null` = no limit. |
| `pilotNodeIds` | Only orders **from** these Nodes. `null` = all Nodes. |
| `maxCostShare` | Refuse a booking if the courier's price exceeds this share of the delivery fee (0.75 = 75%). `null` = no cap. |
| `lowBalanceAlertKobo` | Alert when the prepaid wallet drops below this. |
| `activeDeliveries` | Deliveries in progress with this courier now. |
| `registered` | `false` = the server isn't configured for this courier (no API key). Show a warning. |
| `capabilities` | Read-only. `null` when not registered. |

#### `PATCH /admin/logistics/providers/:key`

Send only the fields you change; `null` clears a nullable setting. The alert threshold is
entered in **naira**:

```json
{
  "enabled": true,
  "maxAttempts": 2,
  "assignTimeoutMinutes": 20,
  "minDistanceKm": 0.1,
  "maxDistanceKm": 80,
  "pilotNodeIds": ["7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38"],
  "maxCostShare": 0.75,
  "lowBalanceAlertNaira": 50000
}
```

Limits: `priority` 1–10000, `maxAttempts` 1–10, `assignTimeoutMinutes` 1–1440,
`maxCostShare` 0.1–2, `lowBalanceAlertNaira` ≥ 0 (2 dp). Response `200`: the updated
provider (same shape as a list item).

Errors: `400 VALIDATION_FAILED` (e.g. *minDistanceKm must not exceed maxDistanceKm*),
`409 ILLEGAL_DELIVERY_ACTION` (switching off `in_house`), `404 NOT_FOUND`.

#### `GET /admin/logistics/providers/:key/wallet`

Prepaid couriers only (Sendii). Response `200`:

```json
{
  "providerKey": "sendii",
  "availableKobo": 1200000,
  "balanceKobo": 1250000,
  "heldKobo": 50000,
  "reservedForSurchargesKobo": 900000,
  "freeKobo": 300000,
  "lowBalanceAlertKobo": 1000000,
  "lowBalance": true
}
```

- `balanceKobo` — total in the wallet; `heldKobo` — held by the courier for live jobs;
  `availableKobo` = balance − held.
- `reservedForSurchargesKobo` — headroom kept for possible extra charges on jobs in flight.
- `freeKobo` — what's really spendable on new jobs. Make it the headline number.
- `lowBalance: true` → red banner *"Top up the Sendii wallet"*.

Errors: `404 NOT_FOUND` for couriers without a wallet (e.g. `in_house`),
`502 LOGISTICS_PROVIDER_ERROR` if the courier can't be reached.

### 8.2 Vehicle rules

#### `GET /admin/logistics/vehicle-rules`

```json
[
  { "vehicleClass": "bicycle", "rank": 1, "enabled": false, "parcelSizes": ["small"], "maxWeightKg": 5, "maxLongestSideCm": 40, "updatedAt": "2026-10-20T08:00:00.000Z" },
  { "vehicleClass": "motorbike", "rank": 2, "enabled": true, "parcelSizes": ["small", "medium"], "maxWeightKg": 20, "maxLongestSideCm": 60, "updatedAt": "2026-10-20T08:00:00.000Z" },
  { "vehicleClass": "car", "rank": 3, "enabled": true, "parcelSizes": ["small", "medium", "large", "extra_large"], "maxWeightKg": 50, "maxLongestSideCm": 120, "updatedAt": "2026-10-20T08:00:00.000Z" },
  { "vehicleClass": "van", "rank": 4, "enabled": false, "parcelSizes": ["small", "medium", "large", "extra_large"], "maxWeightKg": 500, "maxLongestSideCm": 250, "updatedAt": "2026-10-20T08:00:00.000Z" }
]
```

A parcel goes by the lowest-`rank` enabled vehicle it fits.

#### `PATCH /admin/logistics/vehicle-rules/:vehicleClass`

Any subset of:

```json
{ "enabled": true, "rank": 3, "parcelSizes": ["small", "medium", "large"], "maxWeightKg": 60, "maxLongestSideCm": 120 }
```

Response `200`: the updated rule. `404 NOT_FOUND` for an unknown class.

### 8.3 Pricing

#### `POST /admin/pricing` — new price list (takes effect immediately)

Inputs in **naira**. The base and per-km fields are the motorbike rate; `vehicleRates`
overrides other vehicles (keys `bicycle`, `car`, `van`, `truck`). Vehicles without an
override use default multipliers of the motorbike rate.

```json
{
  "baseFeeNaira": 1100,
  "perKmRateNaira": 320,
  "destinationFeeNaira": 300,
  "roadDistanceFactor": 1.4,
  "vehicleRates": {
    "car": { "baseFeeNaira": 2500, "perKmRateNaira": 780 }
  }
}
```

Response `201`:

```json
{
  "id": "55a0388c-c6ff-4868-91e9-760e805f6fdd",
  "baseFeeNaira": 1100,
  "baseFeeKobo": 110000,
  "perKmRateNaira": 320,
  "perKmRateKobo": 32000,
  "destinationFeeNaira": 300,
  "destinationFeeKobo": 30000,
  "roadDistanceFactor": 1.4,
  "vehicleRates": {
    "car": { "baseFeeNaira": 2500, "baseFeeKobo": 250000, "perKmRateNaira": 780, "perKmRateKobo": 78000 }
  },
  "effectiveFrom": "2026-10-25T10:00:00.000Z",
  "createdByAdminId": "800b63cd-bcf3-4b74-915a-9e7d27526873"
}
```

`GET /admin/pricing` returns the history, newest first, in the same shape. Price for a
trip = vehicle base + per-km × road km + destination fee — a small "10 km costs ₦…"
calculator next to the form helps Admins sanity-check.

### 8.4 Route distances — the "Refresh routes" button

#### `POST /admin/logistics/route-distances/refresh`

Measures the real road distance between every pair of active Nodes in the background (a
few seconds per pair). Optional body:

```json
{ "includePending": false }
```

`includePending: true` also measures Nodes still awaiting approval (pilot prep).

Response `202`:

```json
{ "queued": true, "alreadyRunning": false, "providerKey": "sendii", "pairs": 42, "estimatedSeconds": 90 }
```

If a refresh is already running you get `"queued": false, "alreadyRunning": true` — show
*"Already refreshing…"*, not an error.

#### `GET /admin/logistics/route-distances?includePending=false` — progress and coverage

```json
{
  "measuringProvider": "sendii",
  "refreshRunning": true,
  "eligiblePairs": 42,
  "measuredPairs": 30,
  "lastMeasuredAt": "2026-10-25T10:02:41.000Z",
  "routes": [
    {
      "originNodeId": "7a1d9e42-3c5b-4f8a-b2e6-0c9d4a7f1e38",
      "originNodeName": "Ejigbo Station",
      "destinationNodeId": "c84b2f17-6e3a-4d9c-8a51-f27e0b6d3a94",
      "destinationNodeName": "Pedro Road Station",
      "straightLineKm": 6.4,
      "roadDistanceKm": 9.2,
      "source": "sendii",
      "updatedAt": "2026-10-25T10:02:41.000Z"
    }
  ]
}
```

While `refreshRunning` is `true`, poll every 5 s and show a progress bar
`measuredPairs / eligiblePairs`. Pairs not yet measured are priced on the straight-line
estimate (`distanceSource: "estimate"` on quotes).

### 8.5 Deliveries (courier bookings)

#### `GET /admin/logistics/deliveries`

Query (all optional): `orderId`, `trackingCode` (forgiving, like the scan), `status` (a
`DeliveryLegStatus`), `provider`, `stuck=true` (in progress but nothing heard for 30+
min), `from` / `to` (ISO dates), `page`, `limit`.

Response `200`:

```json
{
  "items": [
    {
      "id": "9d4e7b1a-2c6f-4a3e-b8d5-6f0a1c9e2b47",
      "orderId": "3f6c2a1e-8b4d-4e2a-9c7f-1d5e8a2b4c60",
      "orderTrackingCode": "LCM-7K3M-Q9TD",
      "orderStatus": "rider_assigned",
      "provider": "sendii",
      "providerLabel": "Sendii",
      "legType": "forward",
      "status": "assigned",
      "providerStatus": "assigned",
      "externalId": "SND-58213",
      "attemptNumber": 1,
      "vehicleClass": "motorbike",
      "courierName": "Musa A.",
      "courierPhone": "+2348031112222",
      "quotedKobo": 150000,
      "actualKobo": null,
      "surchargeKobo": 0,
      "failureReason": null,
      "createdAt": "2026-10-25T10:12:04.000Z",
      "updatedAt": "2026-10-25T10:20:41.000Z",
      "endedAt": null
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

- One order can have several deliveries (retries, fallback to riders, the return leg).
  Filter by `trackingCode` to see an order's full courier history.
- `externalId: null` with `status: "requested"` = the courier never received the booking
  → **Retry**.
- `providerStatus` is the courier's raw status (for debugging).
- `quotedKobo` = the courier's price at booking; `actualKobo` = its final charge once
  known; `surchargeKobo` = extras on top.
- `failureReason` examples: `admin_fallback`, `assign_timeout`, or the courier's own reason.

#### Actions — `POST /admin/logistics/deliveries/:id/retry | fallback | reconcile`

No body. Response `200`: the updated delivery (same shape as a list item).

| Action | Use when | Refused with `409 ILLEGAL_DELIVERY_ACTION` when |
|---|---|---|
| `retry` | The booking never reached the courier (`externalId: null`) | The courier already has it — use `reconcile` |
| `fallback` | Take it off the courier and give it to Locoomo riders | Already picked up (`picked_up` or later) |
| `reconcile` | Pull the courier's latest status now (e.g. a missed webhook) | — |

After `fallback` the returned delivery is `cancelled` with
`failureReason: "admin_fallback"`, and a new `in_house` delivery appears for the order.

### 8.6 Economics

#### `GET /admin/logistics/economics?provider=sendii&from=…&to=…`

Per-order courier economics. Response `200`:

```json
{
  "items": [
    {
      "orderId": "3f6c2a1e-8b4d-4e2a-9c7f-1d5e8a2b4c60",
      "orderTrackingCode": "LCM-7K3M-Q9TD",
      "orderStatus": "completed",
      "providers": ["sendii"],
      "customerPaidKobo": 434400,
      "deliveryFeeKobo": 404400,
      "courierCostKobo": 150000,
      "settled": false,
      "createdAt": "2026-10-25T09:58:12.000Z",
      "courierAllocationKobo": 242640,
      "allocationEstimated": true,
      "marginKobo": 92640
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 19,
  "totals": {
    "orders": 19,
    "customerPaidKobo": 2609000,
    "courierCostKobo": 1500000,
    "courierAllocationKobo": 1508400,
    "marginKobo": 8400
  }
}
```

- `courierAllocationKobo` — the share of the delivery fee set aside for whoever carries
  the parcel (the rider share of the revenue split).
- `marginKobo` = allocation − courier cost. Negative = the courier cost more than
  budgeted — highlight red.
- `allocationEstimated: true` — no revenue-split entry yet; computed from the current split.
- `settled` — the courier's final cost is confirmed.
- `totals` covers the whole filter, not just the current page.

---

## 9. Error codes

Codes a logistics screen can receive, and what to do:

| HTTP | `code` | Where | Suggested handling |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | any | Map `details[].field` to form fields |
| 401 | `UNAUTHENTICATED` | any except `/track` | Refresh the session / go to login |
| 401 | `INVALID_HANDOFF_CODE` | confirm-handoff, collect, return-collect | *"Code didn't match or expired"*; offer a new code / resend |
| 403 | `FORBIDDEN` | any | Wrong role for this screen |
| 403 | `NODE_NOT_ACTIVE` | Node dispatch | *"Your station is awaiting approval"* |
| 403 | `RIDER_NOT_ACTIVE` | rider accept | *"Your rider account is awaiting approval"* |
| 404 | `NOT_FOUND` | any | Doesn't exist **or isn't yours** |
| 409 | `NODE_CAPACITY_UNAVAILABLE` | checkout | *"This station is full — choose another"* |
| 409 | `ILLEGAL_ORDER_TRANSITION` | rider accept, counter actions | The order moved on — refresh it |
| 409 | `RIDER_CAPACITY_UNAVAILABLE` | rider accept | *"Finish a delivery first"* |
| 409 | `ORDER_NOT_READY_FOR_COLLECTION` | resend code | Refresh the order |
| 409 | `COURIER_HANDOVER_NOT_AVAILABLE` | courier-handover | Refresh / re-scan |
| 409 | `ILLEGAL_DELIVERY_ACTION` | admin delivery actions, courier settings | Show `message` to the Admin |
| 422 | `NO_DELIVERY_OPTION` | quote, checkout, dispatch | *"Too big or heavy for our vehicles, or no courier on this route"* |
| 429 | `RATE_LIMITED` | quote, checkout, codes, tracking | *"Too many tries — wait a minute"* |
| 502 | `LOGISTICS_PROVIDER_ERROR` | courier-handover, wallet | *"Courier service unavailable — try again"* |
| 503 | `PRICING_NOT_CONFIGURED` | quote, checkout | *"Pricing unavailable"* (an Admin must add a pricing rule) |

Admin screens may show `error.message` directly (it's written for operators); sender,
Node and rider screens should use your own copy keyed on `code`.

---

## 10. Polling and refresh guidance

There are no websockets; poll gently and stop when nothing more can change.

| Screen | Poll | Stop when |
|---|---|---|
| Node: courier code read out, waiting for it to be used | `by-tracking-code` every 3–5 s | `nextAction` changes, or after ~10 min |
| Node: work queues | every 30 s while visible | screen hidden |
| Sender: order details | every 30 s while visible | `completed` / `return_completed` / `cancelled` |
| Public tracking | every 60 s while visible | `isFinal: true` |
| Admin: route refresh | `route-distances` every 5 s | `refreshRunning: false` |
| After the payment redirect | `payments/intents/:id` every 2 s | `paid` / `failed` / `expired` |

Pause polling while the tab is hidden (`document.visibilityState`), and back off on `429`.
