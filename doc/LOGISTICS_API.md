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
Sendii found no rider → retried → fell back to an in-house rider). If it has to go back,
the same courier brings it back on that delivery (its `status` becomes `returning`, then
`returned`). You only ever see the **current** delivery, as the
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

### `delivery` — **live** (phase 2)

Documented in [API.md › Delivery object](API.md#delivery-object); on consumer orders, the
Node scan lookup and `my-node/orders`. Only `provider: "in_house"` occurs until the first
external courier ships (phase 3) — but build the `give_code_to_courier` path now.

### `parcel` attributes — **live** (phase 4)

Documented in [API.md › POST /payments/intents](API.md#post-apiv1paymentsintents) and
[Pricing](API.md#pricing).

### `openingHours` (Nodes) — **live**

Shipped in phase 0 — documented in [API.md › Opening hours](API.md#opening-hours).

## Consumer (sender) app

### Quotes, parcel details and vehicle pricing — **live** (phase 4)

`POST /delivery-quotes`, the parcel fields and new `feeBreakdown` on
`POST /payments/intents` (and `dispatch`), and `NO_DELIVERY_OPTION` are documented in
[API.md › Pricing](API.md#pricing). Differences from this draft: weight is accepted up to
1000 kg (anything a vehicle can't carry is the 422, not a 400), and `feeBreakdown` keeps
`baseFeeKobo`/`perKmRateKobo` (the applied vehicle rate) alongside the new fields.

### `GET /api/v1/orders` and `GET /api/v1/orders/:id` — changed *(phases 1–5)*

`trackingUrl` and `labelInstructions` are **live** (phase 1) — see
[API.md › GET /orders](API.md#get-apiv1orders).

Still to come on each order:

| Field | Phase | Notes |
|---|---|---|

Return statuses (phase 5) appear in `status`; when present, show the origin Node's
details (`originNodeName`, `originNodeAddress`) as the collection point.

## Node app (operators & staff)

### Scan lookup, work queues, shelf numbers — **live** (phase 1)

The forgiving `by-tracking-code` lookup at both Nodes (`myRole`, `nextAction`,
`shelfNumber`, `receiverMasked`), the `queue` filter on `my-node/orders`, and `shelfNumber`
on drop-off/intake are documented in
[API.md › by-tracking-code](API.md#get-apiv1handoffsordersby-tracking-codecode) and
[Shelf numbers](API.md#shelf-numbers).

`delivery`, the external-courier `nextAction` values `hand_to_courier` /
`receive_from_courier` and the courier handover endpoint they lead to are live (phases
2–3). Still to come: the return values (phase 5) — see [nextAction](#nextaction-node-app--what-the-operator-at-this-node-should-do-now).
If the QR decodes to a full tracking URL, send it as-is — the server extracts the code.

### `GET /api/v1/handoffs/orders/:id/courier-handover` — **live** (phase 3)

Documented in [API.md](API.md#get-apiv1handoffsordersidcourier-handover).

### Returns — **live** (phase 5)

`return-intake`, `return-collect`, the return statuses, `nextAction` values and emails are
documented in [API.md › Returns](API.md#returns).

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

## Admin app — **live** (phase 6)

Documented in [API.md › Admin: couriers and deliveries](API.md#admin-couriers-and-deliveries).
In addition to this draft: vehicle-rule endpoints, `lowBalanceAlertNaira` and
`maxCostShare` settings, and `freeKobo` on the wallet.

## New error codes

| HTTP | code | Meaning |
|---|---|---|

## Rollout & phase map

| Phase | Frontend-visible scope |
|---|---|
| 0 | ✅ Node `contactPhone`, `openingHours`, `PATCH …/contact`, location check (all live) |
| 1 | ✅ Forgiving lookup at both Nodes, `nextAction`, `shelfNumber`, `receiverMasked`, queues, `trackingUrl`, `labelInstructions`, public tracking endpoint, email links + QR (all live) |
| 2 | ✅ `delivery` object, courier-aware `nextAction`, rider pool excludes courier orders (all live; only `in_house` until phase 3) |
| 3 | ✅ Sendii adapter (behind a switch, off by default), `courier-handover`, webhooks, courier allocation in earnings (live) |
| 4 | ✅ Parcel attributes, `delivery-quotes`, vehicle-based pricing, new `feeBreakdown`, `NO_DELIVERY_OPTION` (live; placeholder rates) |
| 5 | ✅ Return statuses, `return-intake`, `return-collect`, sender emails, public return statuses (all live) |
| 6 | ✅ Admin logistics endpoints (live) |

Sendii is rolled out gradually: first in **shadow mode** (no visible change — the system only
records what Sendii would have cost), then for a pilot list of Nodes, then by default.
During the pilot both `handover` modes will be live at the same time, so build both paths in
the Node app from phase 3.
