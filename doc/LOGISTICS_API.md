# Logistics & Courier API — Frontend Contract (DRAFT)

> **Status: draft contract, nothing here is live yet.** This describes the API surface the
> courier integration (Sendii first, more couriers later) and the public tracking page will
> add, so frontend work can start in parallel. Every endpoint is tagged with the delivery
> phase it ships in. Field names and shapes are intended to be final, but may still change
> until the phase ships — when it does, the section moves into [API.md](API.md) and is
> removed from here.

Everything in [API.md](API.md) still applies: same base URL (`{API_ORIGIN}/api/v1`), same
cookie auth (`credentials: 'include'`), same `{ success, data | error }` envelope, branch on
`error.code` never `error.message`, money is always integer **kobo**, timestamps are ISO-8601
UTC.

## Contents

- [What changes, per app](#what-changes-per-app)
- [Concepts](#concepts)
- [Status reference](#status-reference)
- [Shared objects](#shared-objects)
- [Consumer (sender) app](#consumer-sender-app)
- [Node app (operators & staff)](#node-app-operators--staff)
- [Rider app (in-house riders)](#rider-app-in-house-riders)
- [Public tracking page](#public-tracking-page--live-phase-1)
- [Admin app](#admin-app)
- [New error codes](#new-error-codes)
- [Rollout & phase map](#rollout--phase-map)

## What changes, per app

| App | What's new for you |
|---|---|
| **Consumer (sender)** | Price preview before payment; parcel weight/dimensions/handling at checkout; a `delivery` block and return statuses on orders; a tracking link to share; "label your parcel" instructions |
| **Node app** | Tracking-code lookup works at **both** origin and destination and tells you the **next action**; shelf numbers; a courier handover screen showing the code to give an external courier; return intake and sender collection; structured opening hours and a contact phone on Nodes |
| **Rider app** | No contract changes. `available-orders` simply stops showing orders that have been handed to an external courier |
| **Public tracking page** *(new, no login)* | One endpoint, reached from a link in emails or by typing tracking code + last 4 digits of the receiver's phone |
| **Admin** | Courier provider settings, delivery monitoring and manual interventions (retry, fall back to in-house, cancel), courier wallet balance |

## Concepts

**Order vs delivery.** An *order* is what the customer sees — custody of the parcel from
drop-off to collection (`status`, below). A *delivery* is one courier's attempt at moving it
between Nodes. An order normally has one delivery, but can have several over its life (e.g.
Sendii found no rider → retried → fell back to an in-house rider), and gets a separate
`return` delivery if it has to go back. You only ever see the **current** delivery, as the
`delivery` object on order responses.

**Providers.** Who physically moves the parcel. Treat `delivery.provider` as an **opaque
string** and display `delivery.providerLabel` — new couriers will be added without a frontend
release, so never `switch` on provider values for anything but optional branding.

| `provider` | `providerLabel` | Notes |
|---|---|---|
| `in_house` | `Locoomo rider` | Today's flow — riders claim jobs in the rider app |
| `sendii` | `Sendii` | First external courier. Dispatched automatically after drop-off |
| *(future)* | *(from API)* | No frontend change needed |

**Assignment is automatic.** After the origin Node confirms drop-off, the system picks a
courier (Sendii by default; in-house riders if the route isn't eligible for Sendii or Sendii
fails). Nobody in any app chooses the courier.

**Handover codes run in two directions** — this is the one thing the Node app must render
differently per delivery:

| Courier | Pickup at origin | Arrival at destination |
|---|---|---|
| In-house rider | Rider **shows** their code → operator **enters** it (`confirm-handoff`, unchanged) | Same, `rider_arrival` |
| External courier (Sendii) | Operator **reads out** a code from the courier handover screen → courier enters it in *their* app. The order advances on its own a few seconds later | Same, with the delivery code |

The response tells you which applies: `delivery.handover` is `enter_rider_code` or
`give_code_to_courier`.

**Shelf numbers.** When a parcel is received at a Node (drop-off at origin, intake at
destination, return intake at origin) the API assigns a short per-Node number, e.g. `17`.
The operator writes it large on the parcel; every screen shows it so staff can find the
parcel without reading tracking codes off shelves. Numbers are reused once a parcel leaves.

## Status reference

### Order `status` (customer-facing custody state)

Existing values are unchanged. New values are marked **new** — make sure every `switch` on
`status` has a sensible default so a future value never crashes a screen.

| `status` | Meaning | Phase |
|---|---|---|
| `awaiting_drop_off` | Paid; sender hasn't dropped the parcel yet | live |
| `parcel_received_at_origin` | At origin Node; courier being arranged | live |
| `rider_assigned` | A courier (in-house or external) has accepted the job | live (meaning widened to any courier) |
| `in_transit` | Courier has the parcel | live |
| `arrived_at_destination` | Courier handed it to the destination Node | live |
| `ready_for_collection` | Destination Node has shelved it; receiver emailed a code | live |
| `completed` | Receiver collected it | live |
| `return_initiated` **new** | Delivery couldn't be completed; a return has been decided (may be very brief) | 5 |
| `return_in_transit` **new** | Parcel is on its way back to the origin Node | 5 |
| `returned_to_origin` **new** | Courier handed it back to the origin Node | 5 |
| `ready_for_sender_collection` **new** | Origin Node has shelved it; sender emailed a code | 5 |
| `return_completed` **new** | Sender collected it back | 5 |
| `cancelled`, `disputed` | Reserved; nothing reaches these yet | — |

### `delivery.status` (courier execution state)

Normalised across all couriers — you'll never see a provider's raw status.

| `delivery.status` | Meaning |
|---|---|
| `requested` | Asked the courier for a rider; waiting for one |
| `assigned` | A rider is on the way to pick up |
| `picked_up` | Rider has the parcel |
| `attempt_failed` | A drop-off attempt failed; the courier will retry (order stays `in_transit`) |
| `delivered` | Rider handed over at the destination |
| `returning` | Rider is bringing the parcel back to origin |
| `returned` | Rider handed it back at origin |
| `cancelled` | This attempt ended before pickup; a new delivery (maybe another courier) follows automatically |

### `nextAction` (Node app — what the operator at *this* Node should do now)

Returned by the Node lookup and list endpoints, computed for **your** Node's role in the
order. Drive the main button off this instead of re-deriving it from statuses.

| `nextAction` | Show | Calls |
|---|---|---|
| `confirm_drop_off` | "Receive parcel" | `POST /handoffs/orders/:id/drop-off` |
| `await_courier` | "Waiting for a courier" (no button) | — |
| `hand_to_rider` | "Hand to rider — enter their code" | `POST /handoffs/orders/:id/confirm-handoff` `rider_pickup` |
| `hand_to_courier` | "Hand to courier — give them the code" | `GET /handoffs/orders/:id/courier-handover` |
| `await_arrival` | "On the way to you" (no button) | — |
| `receive_from_rider` | "Receive from rider — enter their code" | `POST .../confirm-handoff` `rider_arrival` |
| `receive_from_courier` | "Receive from courier — give them the code" | `GET .../courier-handover` |
| `intake` | "Shelve parcel" | `POST /handoffs/orders/:id/intake` |
| `hand_to_receiver` | "Hand to receiver" | `POST /handoffs/orders/:id/collect` |
| `return_intake` | "Returned parcel — shelve it" | `POST /handoffs/orders/:id/return-intake` |
| `hand_to_sender` | "Hand back to sender" | `POST /handoffs/orders/:id/return-collect` |
| `none` | Read-only | — |

## Shared objects

### `delivery` *(phase 2/3)*

Present on order responses once a delivery exists, otherwise `null`. Which fields are filled
depends on who's asking (see each endpoint).

```json
{
  "provider": "sendii",
  "providerLabel": "Sendii",
  "type": "forward",
  "status": "assigned",
  "vehicleClass": "motorbike",
  "handover": "give_code_to_courier",
  "courier": { "name": "Musa A.", "phone": "+2348031234567", "vehicle": "Motorbike" },
  "etaMinutes": 32,
  "attemptNumber": 1,
  "updatedAt": "2026-10-21T10:02:00.000Z"
}
```

| Field | Notes |
|---|---|
| `type` | `forward` or `return` |
| `vehicleClass` | `bicycle`, `motorbike`, `car`, `van`, `truck` — not every courier offers every class |
| `handover` | `enter_rider_code` (in-house) or `give_code_to_courier` (external) |
| `courier` | `null` until assigned. `phone` is **only** returned to the Node app |
| `etaMinutes` | Courier's estimate, may be `null`; don't present as a promise |
| `attemptNumber` | Increments when a delivery is retried or falls back to another courier |

### `parcel` attributes *(phase 4)*

Used at checkout and returned on orders.

```json
{
  "parcelSize": "medium",
  "weightKg": 3.5,
  "lengthCm": 40,
  "widthCm": 30,
  "heightCm": 20,
  "handling": ["fragile"]
}
```

| Field | Rules |
|---|---|
| `parcelSize` | unchanged: `small`, `medium`, `large`, `extra_large` |
| `weightKg` | 0.1–50, up to 1 decimal. **Optional at first, will become required** |
| `lengthCm`/`widthCm`/`heightCm` | 1–200, integers, optional (send all three or none) |
| `handling` | array of `fragile`, `keep_upright`, `perishable`, `liquid`; optional, default `[]` |

Limits are provisional until the Sendii agreement fixes per-vehicle limits.

### `openingHours` (Nodes) — **live**

Shipped in phase 0 — documented in [API.md › Opening hours](API.md#opening-hours).

## Consumer (sender) app

### `POST /api/v1/delivery-quotes` — new *(phase 4)*

**Requires an authenticated Consumer, NodeOperator or NodeStaff session.** Price preview
before payment — today the price only appears after `POST /payments/intents` has already
reserved capacity. Call it whenever origin, destination or parcel attributes change. Nothing
is reserved. Rate-limited to 30/min.

Request:

```json
{
  "originNodeId": "uuid",
  "destinationNodeId": "uuid",
  "parcelSize": "medium",
  "weightKg": 3.5,
  "handling": []
}
```

Response `200`, `data`:

```json
{
  "amountKobo": 520000,
  "vehicleClass": "motorbike",
  "estimatedDeliveryMinutes": 45,
  "distanceKm": 9.2,
  "validUntil": "2026-10-21T10:15:00.000Z"
}
```

The amount shown here is what `POST /payments/intents` will charge if called before
`validUntil` with the same inputs. `estimatedDeliveryMinutes` is the courier leg only (after
drop-off), not end-to-end.

Errors: `400 VALIDATION_FAILED`, `404 NOT_FOUND` (Node missing, inactive or private),
`422 NO_DELIVERY_OPTION`, `429 RATE_LIMITED`, `503 PRICING_NOT_CONFIGURED`.

### `POST /api/v1/payments/intents` — changed *(phase 4)*

Accepts the [parcel attributes](#parcel-attributes-phase-4) above in addition to today's
fields. `parcelSize` **will affect the fee** from this phase on (via the vehicle it needs).
Response gains `vehicleClass`, and `feeBreakdown` changes to:

```json
{
  "pricingRuleId": "uuid",
  "deliveryFeeKobo": 470000,
  "destinationFeeKobo": 50000,
  "distanceKm": 9.2,
  "vehicleClass": "motorbike",
  "totalKobo": 520000
}
```

Show `totalKobo`; treat the other fields as informational (the formula behind them is being
agreed and will change). New error: `422 NO_DELIVERY_OPTION`. Same changes apply to
`POST /api/v1/node-operators/nodes/:nodeId/dispatch`.

### `GET /api/v1/orders` and `GET /api/v1/orders/:id` — changed *(phases 1–5)*

`trackingUrl` and `labelInstructions` are **live** (phase 1) — see
[API.md › GET /orders](API.md#get-apiv1orders).

Still to come on each order:

| Field | Phase | Notes |
|---|---|---|
| `delivery` | 2/3 | [Shared object](#delivery-phase-23); `courier.phone` is always omitted for consumers |
| `parcel` | 4 | Attributes captured at checkout |

Return statuses (phase 5) appear in `status`; when present, show the origin Node's
details (`originNodeName`, `originNodeAddress`) as the collection point.

## Node app (operators & staff)

### Scan lookup, work queues, shelf numbers — **live** (phase 1)

The forgiving `by-tracking-code` lookup at both Nodes (`myRole`, `nextAction`,
`shelfNumber`, `receiverMasked`), the `queue` filter on `my-node/orders`, and `shelfNumber`
on drop-off/intake are documented in
[API.md › by-tracking-code](API.md#get-apiv1handoffsordersby-tracking-codecode) and
[Shelf numbers](API.md#shelf-numbers).

Still to come: `delivery` on these responses (phase 2/3), the external-courier
`nextAction` values `hand_to_courier` / `receive_from_courier` (phase 3) and the return
ones (phase 5) — see [nextAction](#nextaction-node-app--what-the-operator-at-this-node-should-do-now).
If the QR decodes to a full tracking URL, send it as-is — the server extracts the code.

### `GET /api/v1/handoffs/orders/:id/courier-handover` — new *(phase 3)*

**Requires an authenticated NodeOperator or NodeStaff session** at the Node that is
handing over right now (origin for pickup, destination for arrival, origin again for a
return). Only for `delivery.handover: "give_code_to_courier"`.

Response `200`, `data`:

```json
{
  "kind": "pickup",
  "code": "731942",
  "courier": { "name": "Musa A.", "phone": "+2348031234567", "vehicle": "Motorbike" },
  "providerLabel": "Sendii",
  "shelfNumber": 17,
  "trackingCode": "LCM-4F2K-9XPT"
}
```

Flow: operator scans/types the parcel → `nextAction` is `hand_to_courier` → open this screen →
check the courier's name against `courier.name` → **read `code` to the courier** → courier
enters it in their own app → the order moves to `in_transit` on its own within seconds. Poll
`by-tracking-code` (every 3–5 s, stop after 2 min) to show "Handed over ✓".

- `kind` is `pickup`, `delivery` or `return_delivery`.
- **The code is a credential**: don't store it, log it, cache it or send it to analytics.
  Fetch it fresh each time the screen opens; never put it in a URL.
- The code is fetched live from the courier, so this can be slower (≤ 3 s) and can fail with
  `502` — show "Couldn't load the code, try again".

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND` (not your Node / not the
handing-over side), `409 COURIER_HANDOVER_NOT_AVAILABLE` (no courier assigned yet, already
handed over, or this delivery uses rider codes instead), `502 LOGISTICS_PROVIDER_ERROR`.

### `POST /api/v1/handoffs/orders/:id/return-intake` — new *(phase 5)*

Origin Node, when a returned parcel is back on the counter (`returned_to_origin →
ready_for_sender_collection`). Mints a collection code and emails it to the **sender**.
Same shape and behaviour as `intake`, including `shelfNumber`. Idempotent.

Errors: as `intake`, with `409 ILLEGAL_ORDER_TRANSITION` if not `returned_to_origin`.

### `POST /api/v1/handoffs/orders/:id/return-collect` — new *(phase 5)*

Origin Node, sender collecting the returned parcel (`ready_for_sender_collection →
return_completed`). Same request, rules and errors as `collect`:

```json
{ "code": "738204", "identityConfirmed": true }
```

`POST /handoffs/orders/:id/collection-code/resend` also works in
`ready_for_sender_collection` (re-sends to the sender).

### Node profile fields — **live**

`contactPhone`, `openingHours`, the owner endpoint `PATCH
/node-operators/nodes/:nodeId/contact` and the map-pin location check
(`NODE_LOCATION_MISMATCH`, `locationCheck`) all shipped in phase 0 — see
[API.md › POST /nodes](API.md#post-apiv1nodes) and [Location check](API.md#location-check).

## Rider app (in-house riders)

No request/response changes. Behaviour changes to be aware of:

- `GET /handoffs/available-orders` only lists orders whose current delivery is assigned to
  the in-house pool — orders being handled by an external courier never appear.
- An order can appear in the pool **later than drop-off** (after an external courier failed
  or the route wasn't eligible). Nothing to do differently; just don't assume freshness.
- `POST /handoffs/orders/:id/accept` may return `409 ILLEGAL_ORDER_TRANSITION` if the
  order left the pool between listing and accepting — refresh the list.

## Public tracking page — **live** (phase 1)

Documented in [API.md › Public tracking](API.md#public-tracking), including the emails that
link to it. Still to come: `courierLabel`/`etaMinutes` filled by external couriers (phase
3) and return statuses (`returning_to_sender`, `returned_to_sender`, `return_completed`,
phase 5).

## Admin app

All **Admin only**. *(phase 6 unless noted)*

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/admin/logistics/providers` | List couriers: `key`, `label`, `enabled`, `priority`, `maxAttempts`, `assignTimeoutMinutes`, `vehicleClasses`, `pilotNodeIds` |
| `PATCH /api/v1/admin/logistics/providers/:key` | Change the above. Disabling a provider stops **new** deliveries only |
| `GET /api/v1/admin/logistics/deliveries` | Paginated; filter `status`, `provider`, `stuck=true` (no progress beyond the provider's timeout), `from`/`to`. Each row: order tracking code, delivery, `quotedKobo`, `actualKobo`, `surchargeKobo`, failure reason |
| `POST /api/v1/admin/logistics/deliveries/:id/retry` | Re-request the same courier |
| `POST /api/v1/admin/logistics/deliveries/:id/fallback` | Cancel with the courier (if still possible) and hand to the in-house pool |
| `POST /api/v1/admin/logistics/deliveries/:id/reconcile` | Pull the latest status from the courier now |
| `GET /api/v1/admin/logistics/providers/:key/wallet` | Prepaid couriers only: `balanceKobo`, `heldKobo`, `availableKobo`, `reservedForSurchargesKobo`, `lowBalance` (bool) |
| `GET /api/v1/admin/logistics/economics` | Per-order customer price, courier cost, surcharges, margin; filter by date/provider/route *(phase 3)* |

Errors: standard, plus `409 ILLEGAL_DELIVERY_ACTION` (e.g. cancel after pickup) and
`502 LOGISTICS_PROVIDER_ERROR`.

## New error codes

| HTTP | code | Meaning |
|---|---|---|
| 422 | `NO_DELIVERY_OPTION` | No courier can carry this parcel on this route (too heavy/large for every vehicle class, or the route isn't served). Ask the sender to adjust the parcel details or pick another Node |
| 409 | `COURIER_HANDOVER_NOT_AVAILABLE` | No handover code to show right now — refresh the order; the `nextAction` will tell you what to do instead |
| 409 | `ILLEGAL_DELIVERY_ACTION` | Admin action not possible in the delivery's current state |
| 502 | `LOGISTICS_PROVIDER_ERROR` | The courier's API failed or timed out. Safe to retry |

## Rollout & phase map

| Phase | Frontend-visible scope |
|---|---|
| 0 | ✅ Node `contactPhone`, `openingHours`, `PATCH …/contact`, location check (all live) |
| 1 | ✅ Forgiving lookup at both Nodes, `nextAction`, `shelfNumber`, `receiverMasked`, queues, `trackingUrl`, `labelInstructions`, public tracking endpoint, email links + QR (all live) |
| 2 | `delivery` object (in-house only at first — `provider: "in_house"`) |
| 3 | External couriers: `courier-handover`, `handover: give_code_to_courier`, Sendii in `delivery` |
| 4 | Parcel attributes, `delivery-quotes`, new `feeBreakdown`, `NO_DELIVERY_OPTION` |
| 5 | Return statuses, `return-intake`, `return-collect` |
| 6 | Admin logistics screens |

Sendii is rolled out gradually: first in **shadow mode** (no visible change — the system only
records what Sendii would have cost), then for a pilot list of Nodes, then by default.
During the pilot both `handover` modes will be live at the same time, so build both paths in
the Node app from phase 3.
