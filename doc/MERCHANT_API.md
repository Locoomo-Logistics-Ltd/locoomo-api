# Locoomo Merchant API

Ship parcels to your customers through Locoomo's network of pickup stations ("Nodes")
across Nigeria. Your buyer picks a Node at checkout. You create a shipment and drop the
parcel at a Locoomo hub or Node. We move it, notify the buyer, and hold it until they
collect it with a one-time code. You follow every step by webhook.

> **Status: v1. The sandbox is open** (test keys, Nodes and quotes, test shipments,
> simulator, webhooks); live shipments follow. This document is the agreed contract for the
> v1 Merchant API. Endpoints are rolled out in the
> order of the [Changelog](#18-changelog). Within v1 we only make
> [additive changes](#3-versioning-and-stability); anything marked *Preview* may still be
> refined before it goes live, and we'll announce it here.

## Contents

1. [How it works](#1-how-it-works)
2. [Quick start (sandbox, 10 minutes)](#2-quick-start-sandbox-10-minutes)
3. [Versioning and stability](#3-versioning-and-stability)
4. [Authentication and API keys](#4-authentication-and-api-keys)
5. [Requests and responses](#5-requests-and-responses)
6. [Nodes and quotes: your checkout picker](#6-nodes-and-quotes-your-checkout-picker)
7. [Shipments](#7-shipments)
8. [Shipment statuses](#8-shipment-statuses)
9. [Labels and parcel identification](#9-labels-and-parcel-identification)
10. [Manifests: bulk drop-off at a hub](#10-manifests-bulk-drop-off-at-a-hub)
11. [Collection, delivery exceptions and returns](#11-collection-delivery-exceptions-and-returns)
12. [Webhooks](#12-webhooks)
13. [Sandbox and testing](#13-sandbox-and-testing)
14. [Billing: wallet, pricing, invoices](#14-billing-wallet-pricing-invoices)
15. [Claims (lost or damaged parcels)](#15-claims-lost-or-damaged-parcels)
16. [Errors](#16-errors)
17. [Go-live checklist](#17-go-live-checklist)
18. [Changelog](#18-changelog)

---

## 1. How it works

```
 Your checkout                 Your warehouse              Locoomo                       Your buyer
 ─────────────                 ──────────────              ───────                       ──────────
 Buyer picks a Node ◄── GET /nodes, GET /quotes
 (you store nodeId)
                               POST /shipments ──────────► hold on your wallet
                               print label, pack
                               POST /manifests (optional)
                               drop at hub/Node ─────────► scanned in, charged ─────► webhook: received
                                                           moved to buyer's Node ───► webhook: in_transit
                                                           shelved, code sent ──────► SMS/email with code
                                                                                       webhook: ready_for_collection
                                                           buyer shows code ────────► webhook: collected
```

| Term | Meaning |
|---|---|
| **Node** | A Locoomo pickup station (shop counter) where buyers collect parcels. |
| **Hub** | A Node that accepts bulk drop-offs from merchants. Your account manager assigns yours. |
| **Shipment** | One parcel to one buyer, identified by your `reference` and our `trackingCode` (`LCM-7K3M-Q9TD`). |
| **Manifest** | A batch of shipments you drop at a hub together. Optional, but recommended above about 20 parcels a day. |
| **Test / live** | Two separate worlds on one account, chosen by the API key you use. Test never touches real Nodes or money. |

**What Locoomo does not do:** we don't collect payment from your buyer. There is no cash on
delivery. You charge your buyer however you like. Locoomo charges **you** per shipment from
a prepaid wallet.

---

## 2. Quick start (sandbox, 10 minutes)

1. **Create an account** at the merchant dashboard (`merchant.locoomo.com`), verify your
   email and create your business. Test keys are available immediately (from the API-keys
   release, see the [changelog](#18-changelog)). You don't need approval to build.
2. **Copy your test secret key** from *Developers › API keys*: `sk_test_…`.
3. **Find a Node** (your checkout would show this list to the buyer):

   ```bash
   curl "https://api.locoomo.com/api/v1/merchant/nodes?near=6.5244,3.3792&radiusKm=5" \
     -H "Authorization: Bearer sk_test_…"
   ```

4. **Create a shipment** to one of the returned Node ids:

   ```bash
   curl https://api.locoomo.com/api/v1/merchant/shipments \
     -H "Authorization: Bearer sk_test_…" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: 6f1d2c1e-9a7b-4f1e-8d2a-3b9c0e5f7a11" \
     -d '{
       "reference": "ORDER-10001",
       "destinationNodeId": "8b0e…",
       "origin": { "type": "node", "nodeId": "<the Node you drop at>" },
       "receiver": { "name": "Chioma Okafor", "phone": "08031234567", "email": "chioma@example.com" },
       "parcel": { "description": "Phone case", "size": "small", "weightKg": 0.3 }
     }'
   ```

5. **Add a webhook endpoint** in *Developers › Webhooks*. Use any HTTPS URL; for a quick
   look, a request-inspector service works.
6. **Simulate delivery**: in the dashboard's test simulator, or with
   `POST /test/shipments/{id}/simulate` ([§13](#13-sandbox-and-testing)). Watch
   `shipment.received` → `shipment.in_transit` → `shipment.ready_for_collection` →
   `shipment.collected` arrive at your endpoint.

When that loop works, follow the [go-live checklist](#17-go-live-checklist).

---

## 3. Versioning and stability

- Base URL: `https://api.locoomo.com/api/v1/merchant` (production). The sandbox uses the
  same URL; your test key selects test mode. The version is in the path.
- **Within v1 we only add**: new endpoints, new optional request fields, new response
  fields, new enum values (statuses, error codes, event types) and new webhook event
  types. Build your integration to **ignore unknown fields and tolerate unknown enum
  values**. For example, treat an unknown status as "in progress" and keep the last known
  state.
- Removing or renaming anything, or changing a field's meaning, only happens in a new
  version (`/v2`). v1 keeps working for at least **6 months** after v2 ships. Responses
  from deprecated endpoints carry `Deprecation` and `Sunset` headers.
- The machine-readable spec is at `GET /api/v1/merchant/openapi.json` (OpenAPI 3.1).
  Generate typed clients from it.

---

## 4. Authentication and API keys

| Key | Prefix | Use from | Can do |
|---|---|---|---|
| Secret key | `sk_test_…` / `sk_live_…` | **Your servers only** | Everything its scopes allow |
| Publishable key | `pk_test_…` / `pk_live_…` | Browsers and mobile apps (your checkout) | Read Nodes and quotes only |

```
Authorization: Bearer sk_live_9fQ2…
```

- The **key decides the mode**: a `_test_` key only ever sees test data; a `_live_` key
  only live data. Ids from one mode don't exist in the other.
- **Secret keys are shown once**, when you create them. Store them in a secrets manager.
  We only keep a hash, so a lost key must be rolled.
- **Live keys** need an approved account and two-factor authentication on the account
  owner. Creating one also requires a fresh identity confirmation in the dashboard.
- **Scopes** (secret keys): `shipments:read`, `shipments:write`, `manifests:write`,
  `webhooks:manage`, `wallet:read`, `claims:write`. New keys get all of them except
  `webhooks:manage`. A key used on an endpoint outside its scopes gets
  `403 INSUFFICIENT_SCOPE`.
- **Optional restrictions**: an IP allow-list per secret key; an allowed-origins list per
  publishable key; and "hide prices" on a publishable key if your negotiated rates
  shouldn't be visible in the browser.
- **Rotation without downtime**: *Roll key* creates a new key and keeps the old one working
  for a period you choose (now, 1 hour, 24 hours or 7 days). Deploy the new key, then let
  the old one expire.
- **Leaked key?** Roll it immediately (choose "now"). The dashboard also has *Revoke all
  live keys*.
- Never put a secret key in a URL. Keys in query strings are rejected.

Invalid, revoked or expired keys all return the same `401 INVALID_API_KEY`. So do keys
used from an IP or browser origin outside their allow-list.

**Check a key**: `GET /ping` (any key) tells you which account and mode it belongs to and
what it may do:

```bash
curl https://api.locoomo.com/api/v1/merchant/ping -H "Authorization: Bearer sk_test_…"
```

```json
{
  "success": true,
  "data": {
    "merchantId": "5d0c…",
    "mode": "test",
    "keyKind": "secret",
    "scopes": ["shipments:read", "shipments:write", "manifests:write", "wallet:read", "claims:write", "nodes:read", "quotes:read"]
  }
}
```

Every key, secret or publishable, can read Nodes and quotes (`nodes:read`, `quotes:read`).
Changes to a key (revoke, roll, new restrictions) apply immediately.

---

## 5. Requests and responses

### 5.1 Envelope

Every response is JSON in an envelope. Read `data`.

```json
{
  "success": true,
  "data": { "id": "…", "status": "created" },
  "meta": { "correlationId": "b1f2c3d4-…", "timestamp": "2026-11-12T09:14:00.000Z" }
}
```

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_WALLET_BALANCE",
    "message": "Your wallet balance is too low for this shipment",
    "correlationId": "b1f2c3d4-…",
    "details": [{ "field": "receiver.phone", "constraint": "isPhoneE164", "message": "receiver.phone must be a valid phone number" }]
  }
}
```

- Branch on **`error.code`** (stable). `message` is human-readable and may change.
- `details` appears on validation errors (`400 VALIDATION_FAILED`). `field` is the full
  path, e.g. `receiver.phone`, or `items[3].receiver.phone` in bulk requests.
- Quote the **`correlationId`** (also in the `X-Correlation-Id` response header) when you
  contact support.

### 5.2 Conventions

| | |
|---|---|
| Money | Integer **kobo** (`₦1 = 100`), field names end in `Kobo`: `434400` = ₦4,344.00 |
| Time | ISO-8601 UTC (`2026-11-12T09:14:00.000Z`). Working-day rules use Africa/Lagos time |
| Phone numbers | Any Nigerian format is accepted (`0803…`, `234803…`, `+234 803…`). Responses are E.164 (`+2348031234567`) |
| Ids | UUIDs. Look up by your own id with `?reference=` |
| Request body | JSON, UTF-8, max **1 MB** (`413 PAYLOAD_TOO_LARGE`). Larger batches go through [imports](#73-bulk-create) |
| Unknown request fields | Rejected (`400 VALIDATION_FAILED`). This catches typos in field names |

### 5.3 Idempotency: retry without duplicates

Send an `Idempotency-Key` header (we recommend a UUID v4) on every `POST`. If the request
times out or the connection drops, **retry with the same key and the same body**:

| Situation | Result |
|---|---|
| First request with this key | Processed normally |
| Same key + same body again | The **original response**, header `Idempotent-Replayed: true`. Nothing is created twice |
| Same key + different body | `422 IDEMPOTENCY_KEY_REUSED` |
| Same key while the first is still running | `409 IDEMPOTENCY_IN_PROGRESS`. Retry in a second |
| First attempt failed with an error | Retrying with the same key runs it again |

Keys are kept for **24 hours** and are scoped to your account and mode. Your shipment
`reference` is a second safety net: it's unique per account and mode
(`409 DUPLICATE_REFERENCE` returns the existing shipment's id).

### 5.4 Pagination and syncing

List endpoints use cursors:

```
GET /shipments?limit=100&updatedSince=2026-11-12T00:00:00Z
→ { "items": [...], "nextCursor": "eyJ0IjoiMjAy…", "hasMore": true }
GET /shipments?limit=100&updatedSince=2026-11-12T00:00:00Z&cursor=eyJ0IjoiMjAy…
```

- `limit` is 1–200 (default 50). Pass `nextCursor` back until `hasMore` is `false`.
- **Keeping your system in sync**: webhooks are the primary channel. As a safety net, poll
  `updatedSince=<last successful sync time minus 5 minutes>` every 15–60 minutes and apply
  any changes you missed.

### 5.5 Rate limits

| Key | Limit |
|---|---|
| `sk_live_…` | 50 requests/second burst, 3,000/minute |
| `sk_test_…` | 25 requests/second |
| `pk_…` | 30 requests/second per key per end-user IP |

Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`
(seconds until the window resets; for live secret keys these describe the per-minute window).
Over the limit you get `429 RATE_LIMITED` with `Retry-After` (seconds). Back off and retry.
Need more? Ask your account manager.

Many invalid keys from one IP (30 in a minute) block that IP's key attempts for a minute
(`429`), so fix a misconfigured key before retrying in a loop.

**Daily volume:** accounts also have a daily live-shipment limit (generous: individual
sellers 2,000, businesses 100,000). We email you at 80%. At 100%, creation returns
`429 DAILY_LIMIT_REACHED` until midnight Lagos time.

---

## 6. Nodes and quotes: your checkout picker

At checkout your buyer chooses the Node where they'll collect. You can call these
endpoints from the browser with a **publishable key** (CORS is enabled for your allowed
origins), or from your server with a secret key.

### `GET /nodes`

| Query | |
|---|---|
| `near=lat,lng` | Sort by distance from this point (e.g. the buyer's address or device location) |
| `radiusKm` | With `near`. Default 10, max 50 |
| `q` | Search name, address and area |
| `state`, `city` | Filters |
| `parcelSize` | Only Nodes that can currently accept this size (`small` · `medium` · `large` · `extra_large`) |
| `limit`, `cursor` | Pagination (§5.4): `limit` 1–200, default 50 |

Only Nodes that are open for business **and have shelf space** are returned: nearest first
with `near`, otherwise by name. `distanceKm` is `null` without `near`. Test and live keys see
the same Nodes (test shipments point at real Nodes but never reach them).

```json
{
  "items": [
    {
      "id": "8b0e2f4a-…",
      "name": "Yaba Node — Herbert Macaulay",
      "address": "312 Herbert Macaulay Way, Yaba",
      "city": "Lagos",
      "state": "Lagos",
      "latitude": 6.5095,
      "longitude": 3.3711,
      "distanceKm": 1.42,
      "openingHours": {
        "mon": [{ "open": "08:00", "close": "20:00" }],
        "sun": []
      },
      "contactPhone": "+2348090000000",
      "acceptingParcels": true
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

### `GET /nodes/{id}`

One Node, same shape. Use it to re-check a stored Node before creating a shipment:
`404 NOT_FOUND` if it has closed or been withdrawn. A Node that's temporarily full is still
returned, with `acceptingParcels: false`; shipments to it still go ahead, and we reroute
if it's still full when the parcel arrives (§6, picker tips).

### `GET /quotes`

| Query | |
|---|---|
| `destinationNodeId` | Required |
| `parcelSize` | Required: `small` · `medium` · `large` · `extra_large` |
| `weightKg`, `lengthCm`, `widthCm`, `heightCm` | Optional; more accurate price |
| `originNodeId` | Where you'll drop the parcel. Optional once a hub is assigned to your account (it defaults to that hub); until then required (`422 ORIGIN_REQUIRED`) |

```json
{
  "currency": "NGN",
  "amountKobo": 180000,
  "breakdown": { "baseKobo": 120000, "distanceKobo": 69000, "volumeDiscountKobo": -9000, "vatKobo": 12558 },
  "vehicleClass": "motorbike",
  "estimatedReadyInWorkingDays": 2
}
```

- `baseKobo + distanceKobo + volumeDiscountKobo = amountKobo`. Prices include VAT;
  `vatKobo` is the VAT **already included** in `amountKobo` (not added on top), and is
  `0` until VAT is itemised on your invoices.
- `estimatedReadyInWorkingDays` runs from drop-off to ready for collection. An estimate.
- Errors: `404 NOT_FOUND` (a Node isn't available), `422 NO_DELIVERY_OPTION` (too big or
  heavy for any vehicle, or no courier covers the route), `422 ORIGIN_REQUIRED`.

**Quotes are estimates.** The price is fixed when you create the shipment, and adjusted
once when we measure the parcel at drop-off ([§14](#14-billing-wallet-pricing-invoices)).
Publishable keys with "hide prices" return `amountKobo: null` and `breakdown: null`.

**Picker tips:**
- Show a map and list, sorted by distance, with opening hours.
- Store `destinationNodeId` with your order, not the name.
- If the buyer's Node later closes or fills up, **we handle it**: we reroute the parcel to
  a nearby Node, tell the buyer, and send you `shipment.destination_changed`. You don't
  need to ask the buyer again.

---

## 7. Shipments

### 7.1 Create: `POST /shipments`

Scope `shipments:write`. Send `Idempotency-Key`.

```json
{
  "reference": "TEMU-ORD-88412-1",
  "destinationNodeId": "8b0e2f4a-…",
  "origin": { "type": "hub" },
  "receiver": {
    "name": "Chioma Okafor",
    "phone": "08031234567",
    "email": "chioma@example.com"
  },
  "parcel": {
    "description": "Wireless earbuds",
    "size": "small",
    "weightKg": 0.4,
    "lengthCm": 15,
    "widthCm": 10,
    "heightCm": 6,
    "handling": ["fragile"],
    "declaredValueKobo": 2500000
  },
  "externalBarcode": "TM123456789NG",
  "notifyReceiver": "locoomo",
  "metadata": { "orderId": "88412", "warehouse": "CN-SZ-2" }
}
```

| Field | Rules |
|---|---|
| `reference` | Required. Your id for this parcel, 1–64 chars, unique per account and mode |
| `destinationNodeId` | Required. From `/nodes` |
| `origin` | `{ "type": "hub" }` (your assigned hub; the default once you have one) or `{ "type": "node", "nodeId": "…" }` for drop-off at a specific Node. **Required as `node` until a hub is assigned to your account** (`422 ORIGIN_REQUIRED`). If the parcel is actually dropped elsewhere, we re-price from where it really arrived |
| `receiver.name` | Required, 2–100 chars |
| `receiver.phone` | Required, valid phone |
| `receiver.email` | Optional. We recommend it: email is always sent, SMS where available |
| `parcel.description` | Required, ≤ 500 chars. Be specific ("Wireless earbuds", not "Item") |
| `parcel.size` | Required: `small` · `medium` · `large` · `extra_large` |
| `parcel.weightKg` | Optional, 0.1–1000 |
| `parcel.lengthCm` / `widthCm` / `heightCm` | Optional, 1–500 each; send all three or none |
| `parcel.handling` | Optional: any of `fragile`, `keep_upright`, `perishable`, `liquid` |
| `parcel.declaredValueKobo` | Optional. Basis for claims; compensation is capped (see [§15](#15-claims-lost-or-damaged-parcels)) |
| `externalBarcode` | Optional. A barcode already on the parcel; our hub scanners accept it instead of our label ([§9](#9-labels-and-parcel-identification)) |
| `notifyReceiver` | Optional. `locoomo` (default): we send the collection code by SMS/email. `merchant`: you relay it in your own app, since we include it in the `ready_for_collection` webhook. `both`: both. `merchant`/`both` must be enabled on your account first |
| `metadata` | Optional. Up to 50 keys (≤ 40 chars) with string values (≤ 500 chars), 8 KB total, echoed back everywhere |

Response `201`: the [Shipment object](#74-the-shipment-object), status `created`.

What happens at creation:
- The quoted fee is **held** on your wallet (not charged yet). Insufficient balance →
  `402 INSUFFICIENT_WALLET_BALANCE` with `requiredKobo` and `availableKobo`.
- We check the receiver can be reached. With `notifyReceiver: "locoomo"` and no email,
  SMS must be available; otherwise `422 RECEIVER_UNREACHABLE`. Add an email, or use
  `merchant`/`both`.
- If the parcel isn't dropped within **60 days** (hub) or **14 days** (Node), the shipment
  expires, the hold is released and you get `shipment.expired`. The deadline is in
  `dropDeadline`.
- Other errors: `422 DESTINATION_NODE_UNAVAILABLE` (closed or withdrawn; a full Node is
  accepted, see §6), `422 ORIGIN_NODE_UNAVAILABLE`, `422 RECEIVER_RELAY_NOT_ENABLED`
  (`notifyReceiver` `merchant`/`both` not enabled yet), `422 NO_DELIVERY_OPTION`.
- **Live mode** opens with the wallet release (see the changelog). Until then live
  creation returns `403 LIVE_SHIPMENTS_NOT_AVAILABLE` (or `403 MERCHANT_NOT_APPROVED`);
  live reads work and are empty.

### 7.2 Read and list

- `GET /shipments/{id}`
- `GET /shipments?reference=TEMU-ORD-88412-1`
- `GET /shipments?status=ready_for_collection&destinationNodeId=…&manifestId=…&createdFrom=…&createdTo=…&updatedSince=…&limit=&cursor=`
- `GET /shipments/{id}/timeline`: the event history (what, when, which Node), oldest
  first. Besides statuses it includes `updated`, `fee_adjusted` and `destination_changed`.

Lists are newest first. With `updatedSince` they're **oldest change first** (`updatedAt`
ascending), which is what a sync loop wants: page through to the end and remember the
time you started.

```json
[
  { "type": "created", "at": "2026-11-12T09:14:00.000Z", "nodeName": null, "sequence": 1 },
  { "type": "received", "at": "2026-11-14T11:02:00.000Z", "nodeName": "Ikeja Hub", "sequence": 2 },
  { "type": "in_transit", "at": "2026-11-14T15:40:00.000Z", "nodeName": "Ikeja Hub", "sequence": 3 },
  { "type": "ready_for_collection", "at": "2026-11-15T10:05:00.000Z", "nodeName": "Yaba Node — Herbert Macaulay", "sequence": 4 }
]
```

### 7.3 Bulk create

- `POST /shipments/bulk` takes up to **100** shipments in one synchronous call
  (`{ "items": [ …same shape as create… ] }`). Each item succeeds or fails on its own:

  ```json
  {
    "results": [
      { "index": 0, "ok": true, "shipment": { "id": "…", "trackingCode": "LCM-…", "…": "the full Shipment object" } },
      { "index": 1, "ok": false, "error": { "code": "VALIDATION_FAILED", "details": [{ "field": "items[1].receiver.phone", "constraint": "isPhoneE164", "message": "…" }] } }
    ]
  }
  ```

- *(Coming with live shipments.)* `POST /shipment-imports` takes up to **10,000** rows (JSON body ≤ 1 MB, or a CSV upload
  ≤ 5 MB) and processes them in the background. Poll
  `GET /shipment-imports/{id}` → `{ status: "processing" | "done", created, failed, rows: [...] }`.
  The CSV template is downloadable from the dashboard.

### 7.4 The Shipment object

```json
{
  "id": "0c7e5a7b-…",
  "mode": "live",
  "reference": "TEMU-ORD-88412-1",
  "trackingCode": "LCM-7K3M-Q9TD",
  "trackingUrl": "https://app.locoomo.com/track/LCM-7K3M-Q9TD?t=Vd3…",
  "status": "ready_for_collection",
  "sequence": 5,
  "statusChangedAt": "2026-11-15T10:05:00.000Z",
  "origin": { "type": "hub", "nodeId": "…", "nodeName": "Ikeja Hub" },
  "destination": {
    "nodeId": "8b0e2f4a-…",
    "nodeName": "Yaba Node — Herbert Macaulay",
    "address": "312 Herbert Macaulay Way, Yaba",
    "city": "Lagos",
    "state": "Lagos",
    "changed": false
  },
  "receiver": { "name": "Chioma Okafor", "phone": "+2348031234567", "email": "chioma@example.com" },
  "parcel": {
    "description": "Wireless earbuds",
    "size": "small",
    "weightKg": 0.4,
    "lengthCm": 15,
    "widthCm": 10,
    "heightCm": 6,
    "handling": ["fragile"],
    "declaredValueKobo": 2500000,
    "measured": { "weightKg": 0.45, "size": "small" }
  },
  "externalBarcode": "TM123456789NG",
  "manifestId": null,
  "fee": {
    "currency": "NGN",
    "quotedKobo": 180000,
    "chargedKobo": 180000,
    "state": "charged",
    "breakdown": { "baseKobo": 120000, "distanceKobo": 60000, "volumeDiscountKobo": -9000, "vatKobo": 9000 }
  },
  "collection": {
    "deadline": "2026-11-26T22:59:59.000Z",
    "collectedAt": null,
    "method": null,
    "collectorName": null
  },
  "return": null,
  "exception": null,
  "notifyReceiver": "locoomo",
  "metadata": { "orderId": "88412", "warehouse": "CN-SZ-2" },
  "createdAt": "2026-11-12T09:14:00.000Z",
  "updatedAt": "2026-11-15T10:05:00.000Z"
}
```

| Field | Notes |
|---|---|
| `trackingUrl` | Public tracking page. Put it in your order emails; it's safe to share with the buyer. `null` in test mode |
| `dropDeadline` | Drop the parcel off before this, or the shipment expires |
| `sequence` | Increases on every change. Use it to discard out-of-order webhooks ([§12.4](#124-ordering-and-duplicates)) |
| `destination.changed` | `true` if we rerouted to another Node (the buyer was told) |
| `parcel.measured` | What we measured at drop-off, if it differed |
| `fee.state` | `held` (created) → `charged` (received), or `released` (cancelled, expired or refused before drop-off) |
| `collection.deadline` | End of the 7-working-day collection window |
| `collection.method` | `code` or `id_check` (buyer showed photo ID at the counter) |
| `return` | When returning: `{ "reason": "not_collected" \| "delivery_failed" \| "merchant_request", "readyForCollectionAt": … }` |
| `exception` | `{ "type": "lost" \| "damaged", "reportedAt": …, "claimId": … }` |

### 7.5 Change, cancel, return

| Endpoint | Allowed when | Effect |
|---|---|---|
| `PATCH /shipments/{id}` | `receiver.*`: until `collected` (the buyer gets a fresh code; `"email": null` removes it). `destinationNodeId`, `parcel` (send the whole object): only while `created` (re-quoted; the hold is adjusted). `metadata`: replaced, any time | Updated shipment; `shipment.updated` webhook. Otherwise `409 SHIPMENT_NOT_EDITABLE` |
| `POST /shipments/{id}/cancel` | Only while `created` (not yet dropped off) | `cancelled`, hold released. Otherwise `409 SHIPMENT_NOT_CANCELLABLE` |
| `POST /shipments/{id}/return-to-sender` | From `received` until `ready_for_collection` (e.g. the buyer cancelled their order) | The parcel comes back to your hub/Node ([§11](#11-collection-delivery-exceptions-and-returns)). No extra fee in v1. Otherwise `409 SHIPMENT_NOT_RETURNABLE` |

A cancel that races with the drop-off scan has one winner. If the parcel was scanned
first, you get `409 SHIPMENT_NOT_CANCELLABLE`; use return-to-sender instead.

---

## 8. Shipment statuses

```
created ──► received ──► in_transit ──► ready_for_collection ──► collected ✔
   │            │             │                   │
   │            └─────────────┴───────────────────┴──► returning ──► return_ready ──► returned ✔
   │                                                                      │
   ├──► cancelled ✔  (you cancelled before drop-off)                      └──► disposed ✔ (uncollected return, see §11)
   ├──► expired ✔    (never dropped off)
   └──► refused ✔    (refused at the counter: prohibited, unsafe or badly packed)

   any active status ──► exception (lost / damaged, see §15)
```

| Status | Meaning | What you might do |
|---|---|---|
| `created` | Registered; fee held; waiting for drop-off | Print the label, drop it off |
| `received` | Scanned in at the hub/Node; fee charged | Tell the buyer it's on the way |
| `in_transit` | Moving to the buyer's Node | |
| `ready_for_collection` | On the shelf at the buyer's Node; buyer notified | Remind your buyer; relay the code if you use `merchant` notifications |
| `collected` | Buyer collected it (proof in `collection`) | Mark the order delivered |
| `returning` | Coming back (not collected in time, delivery failed, or you asked) | |
| `return_ready` | Back at your hub/Node, waiting for you | Collect it ([§11.3](#113-collecting-your-returns)) |
| `returned` | You collected the return | |
| `cancelled` · `expired` · `refused` | Ended before drop-off; nothing charged | |
| `exception` | Lost or damaged in our custody | A claim is opened automatically |
| `disposed` | An uncollected return was disposed of under the terms, after notices | |

**Tolerate unknown statuses** ([§3](#3-versioning-and-stability)).

---

## 9. Labels and parcel identification

- *(Coming with live shipments.)* `GET /shipments/{id}/label?format=a6` (or `a4`) returns a PDF with the tracking code as a
  **Code 128 barcode and a QR code**, the destination Node, and the receiver's first name.
  Print it and stick it on the parcel. `POST /label-batches` builds one PDF for many
  shipments (in the background).
- **Already have your own barcode on the parcel?** Send it as `externalBarcode` when you
  create the shipment. Our hub scanners accept your barcode, your `reference`, or our
  tracking code, so cross-border parcels don't need relabelling.
- **No printer?** (small sellers) Write the tracking code clearly on the parcel in marker.
  The counter staff check it at drop-off.

---

## 10. Manifests: bulk drop-off at a hub

A manifest tells the hub what's coming, so a truckload is checked in quickly and anything
missing is reported back to you.

1. `POST /manifests` with `{ "hubNodeId": "…", "expectedDropAt": "2026-11-14T09:00:00Z", "shipmentIds": ["…"] }`.
   Add more with `POST /manifests/{id}/shipments`.
2. `POST /manifests/{id}/close` when the truck leaves. Download the manifest PDF/QR
   (`GET /manifests/{id}/document`) for the driver.
3. At the hub, staff scan the manifest and then each parcel. Each one fires
   `shipment.received`.
4. When the hub finishes, you get **`manifest.received`**:

   ```json
   {
     "manifestId": "…",
     "received": 482,
     "missing": [{ "shipmentId": "…", "reference": "TEMU-ORD-88413-1" }],
     "unexpected": [{ "shipmentId": "…", "reference": "TEMU-ORD-90001-1" }]
   }
   ```

   Missing parcels stay `created`, so you can drop them later or cancel them. Unexpected
   parcels that belong to you are accepted normally.

---

## 11. Collection, delivery exceptions and returns

### 11.1 How the buyer collects

When the parcel is shelved at their Node, the buyer gets a **one-time collection code**:

| `notifyReceiver` | The buyer gets the code by |
|---|---|
| `locoomo` (default) | SMS (where available) **and** email (if you gave one) |
| `merchant` | You: the code is in the `shipment.ready_for_collection` webhook (`data.collectionCode`). Show it in your app or send it yourself |
| `both` | Both of the above |

Treat a relayed code like a password: show it only to the buyer, never log it, and never
display it to your support staff. `merchant`/`both` must be enabled on your account.

A buyer without their code can still collect by showing **photo ID** that matches the
receiver name, plus the last 4 digits of the phone number. Staff verify it and the event
is logged (`collection.method: "id_check"`).

### 11.2 The collection window

The buyer has **7 working days** (Monday–Friday, excluding Nigerian public holidays) after
`ready_for_collection`. We send reminders on working days 5 and 6, and you get
`shipment.collection_reminder`. If they don't come, the parcel returns to you
(`returning` → `return_ready`). The return trip is free.

### 11.3 Collecting your returns

Returns come back to the hub/Node they left from. `GET /returns?state=ready` lists them.
Then:

1. `POST /return-batches` with `{ "nodeId": "…", "shipmentIds": [...] }` returns a
   **collection code** for that batch.
2. Your staff go to the Node and show the code; staff hand over the parcels.
3. Each one becomes `returned` (`shipment.returned`).

**Uncollected returns:** you have **10 working days** free after `return_ready`. After that
a small daily storage fee is charged to your wallet, and after 30 more days (with email
notices) the parcel may be disposed of under the merchant terms (`shipment.disposed`).

---

## 12. Webhooks

### 12.1 Setting up

Add endpoints in *Developers › Webhooks*, or over the API with a key that has the
`webhooks:manage` scope (not given to new keys by default). The key's mode decides which
mode the endpoint is for; test and live are configured separately, up to 5 endpoints each.

| Endpoint | |
|---|---|
| `GET /webhook-endpoints` | Your endpoints, without secrets |
| `POST /webhook-endpoints` | `{ "url", "events"?, "description"? }` → `{ "endpoint", "secret" }`. The **signing secret** (`whsec_…`) is shown once. `events`: event types to receive; omit or `[]` for all, including types added later |
| `PATCH /webhook-endpoints/{id}` | Any of `url`, `events`, `description`, `enabled` (`true` re-enables an endpoint we disabled) |
| `DELETE /webhook-endpoints/{id}` | Stop sending and forget it |
| `POST /webhook-endpoints/{id}/roll-secret` | New secret, shown once; the old one keeps signing for 24 hours (§12.3) |
| `POST /webhook-endpoints/{id}/test` | Sends a `webhook.test` event now and answers `{ "delivered", "responseStatus", "durationMs", "error" }` |
| `POST /webhook-endpoints/{id}/replay` | `{ "since": "<ISO time>" }` (within 30 days) → `{ "queued" }`: resends every subscribed event since then (up to 10,000) |
| `GET /webhook-deliveries?endpointId=&status=&limit=&cursor=` | Delivery log, newest first (§12.5) |

URLs must be public `https://` addresses (`422 INVALID_WEBHOOK_URL`); a 6th endpoint is
`409 WEBHOOK_ENDPOINT_LIMIT_REACHED`.

### 12.2 What we send

```http
POST /your/webhook HTTP/1.1
Content-Type: application/json
webhook-id: msg_2b7e1c0a9f…
webhook-timestamp: 1763039100
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=
```

```json
{
  "id": "msg_2b7e1c0a9f…",
  "type": "shipment.ready_for_collection",
  "version": 1,
  "mode": "live",
  "occurredAt": "2026-11-15T10:05:00.000Z",
  "data": {
    "shipment": { "…": "the full Shipment object, as it was at that moment" },
    "sequence": 4
  }
}
```

Extras in `data` for some events: `collectionCode` (`ready_for_collection`, only when you
relay codes, §11.1), `adjustment` (`fee_adjusted`: `previousKobo`, `newKobo`,
`differenceKobo`, `reason`), `previousDestination` (`destination_changed`), `changed`
(`updated`: which parts changed). `merchant.status_changed` carries
`data.merchant: { id, status, previousStatus }`.

Respond with any **2xx within 10 seconds**. Do the heavy work after responding: queue it.

### 12.3 Verify every webhook

We follow the open [Standard Webhooks](https://www.standardwebhooks.com) spec. The
signature is `base64(HMAC-SHA256(secret, "{webhook-id}.{webhook-timestamp}.{raw body}"))`,
keyed with the bytes after `whsec_` (base64-decoded). Verify against the **raw** request
body, before parsing JSON. Reject timestamps more than 5 minutes old. Official Standard
Webhooks libraries exist for most languages.

**Node.js**

```js
import crypto from 'node:crypto';

export function verifyLocoomoWebhook(rawBody, headers, secret) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = String(headers['webhook-signature'] || '');
  if (!id || !timestamp) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');

  return signatures.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    return version === 'v1' && sig && sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
}
// Express: app.post('/webhooks/locoomo', express.raw({ type: 'application/json' }), (req, res) => {
//   if (!verifyLocoomoWebhook(req.body.toString('utf8'), req.headers, process.env.LOCOOMO_WHSEC)) return res.sendStatus(400);
//   res.sendStatus(200); queue(JSON.parse(req.body));
// });
```

**PHP**

```php
function verifyLocoomoWebhook(string $rawBody, array $headers, string $secret): bool {
    $id = $headers['webhook-id'] ?? '';
    $ts = $headers['webhook-timestamp'] ?? '';
    $sigs = $headers['webhook-signature'] ?? '';
    if ($id === '' || $ts === '' || abs(time() - (int) $ts) > 300) return false;

    $key = base64_decode(preg_replace('/^whsec_/', '', $secret));
    $expected = base64_encode(hash_hmac('sha256', "$id.$ts.$rawBody", $key, true));
    foreach (explode(' ', $sigs) as $part) {
        [$v, $sig] = array_pad(explode(',', $part, 2), 2, '');
        if ($v === 'v1' && hash_equals($expected, $sig)) return true;
    }
    return false;
}
// $raw = file_get_contents('php://input'); // the raw body, before json_decode
```

**Python**

```python
import base64, hashlib, hmac, time

def verify_locoomo_webhook(raw_body: bytes, headers: dict, secret: str) -> bool:
    wid, ts = headers.get("webhook-id"), headers.get("webhook-timestamp")
    if not wid or not ts or abs(time.time() - int(ts)) > 300:
        return False
    key = base64.b64decode(secret.removeprefix("whsec_"))
    expected = base64.b64encode(
        hmac.new(key, f"{wid}.{ts}.".encode() + raw_body, hashlib.sha256).digest()
    ).decode()
    for part in headers.get("webhook-signature", "").split(" "):
        version, _, sig = part.partition(",")
        if version == "v1" and hmac.compare_digest(sig, expected):
            return True
    return False
```

When you roll your signing secret, both the old and new secrets sign for 24 hours, so the
header carries two `v1,…` signatures. The code above accepts either.

### 12.4 Ordering and duplicates

- **Delivery is at-least-once.** The same event can arrive twice; deduplicate on
  `webhook-id`.
- **Order is not guaranteed.** Retries can deliver an older event after a newer one. Keep
  the highest `data.sequence` you've applied per shipment and ignore anything lower.
  Because each event carries the **whole shipment**, you never need to merge partial
  updates.

### 12.5 Retries and failures

A delivery that doesn't get a 2xx in 10 seconds is retried after 5 seconds, 1 minute,
5 minutes, 30 minutes, 2 hours, 5 hours, then three times 10 hours apart (about 1.5 days in
total). Each endpoint gets at most 4 requests in flight at once, so a slow endpoint only
delays its own events. If every delivery to an endpoint fails for 36 hours, we **disable
the endpoint** and email your developers. Fix it, re-enable it, then
`POST /webhook-endpoints/{id}/replay` with `{ "since": "…" }` to resend what you missed.
The delivery log (`GET /webhook-deliveries`) keeps 30 days: each delivery's event, status
(`pending`, `delivering`, `succeeded`, `failed`), attempts, next attempt, and your last
response (status and its first 2 KB).

Webhook URLs must be public HTTPS. Private and internal addresses are refused, also when a
hostname resolves to one at send time. Redirects are not followed (a `3xx` counts as a
failure), so register the final URL.

### 12.6 Events

| Event | When |
|---|---|
| `shipment.created` | Created (API, import or dashboard) |
| `shipment.updated` | You changed it, or we corrected parcel details |
| `shipment.cancelled` · `shipment.expired` · `shipment.refused` | Ended before drop-off |
| `shipment.received` | Scanned in; fee charged |
| `shipment.fee_adjusted` | Re-priced after we measured it (`data.adjustment`) |
| `shipment.in_transit` | On its way to the buyer's Node |
| `shipment.destination_changed` | Rerouted to another Node (buyer told) |
| `shipment.ready_for_collection` | Shelved; buyer notified (`data.collectionCode` if you relay codes) |
| `shipment.collection_reminder` | Reminder sent to the buyer |
| `shipment.collected` | Collected; proof in `shipment.collection` |
| `shipment.returning` · `shipment.return_ready` · `shipment.returned` | Return progress |
| `shipment.disposed` | An uncollected return was disposed of |
| `shipment.exception` | Lost or damaged |
| `manifest.received` | Hub finished checking a manifest in |
| `claim.decided` | Claim approved or rejected |
| `wallet.funded` | A top-up was credited: `data.topUp` (§14.1) and `data.wallet` (the wallet after it) |
| `wallet.low_balance` | Available balance fell below your threshold |
| `merchant.status_changed` | Your account was submitted, approved, suspended, etc. Sent to test and live endpoints |
| `webhook.test` | Only from *Send test event*, only to that endpoint |

Sent today: every `shipment.*` event above except `collection_reminder` (live operations),
plus `wallet.funded`, `merchant.status_changed` and `webhook.test`. `manifest.received`,
`claim.decided` and `wallet.low_balance` arrive with their features. Expect new event types over time
([§3](#3-versioning-and-stability)). Ignore the ones you
don't handle and still respond 2xx.

---

## 13. Sandbox and testing

- Use `sk_test_…` / `pk_test_…`. Test mode has its own shipments, webhooks and a **test
  wallet that starts with ₦1,000,000**. It works exactly like a live wallet
  ([§14](#14-billing-wallet-pricing-invoices)): creating a shipment holds its fee, a
  simulated drop-off charges it, and a shipment that can't be paid for is refused with
  `402 INSUFFICIENT_WALLET_BALANCE`. Top it back up to ₦1,000,000 any time with
  `POST /test/wallet/reset` (open holds stay). Nothing reaches real Nodes, couriers, buyers
  or money. **Test tracking codes start with `LCT-`**, and real Nodes refuse them if one is
  ever scanned by mistake.
- Test shipments don't move on their own. Drive them:

  ```bash
  curl https://api.locoomo.com/api/v1/merchant/test/shipments/{id}/simulate \
    -H "Authorization: Bearer sk_test_…" -H "Content-Type: application/json" \
    -d '{ "to": "ready_for_collection" }'
  ```

  `to` accepts any status from [§8](#8-shipment-statuses), plus `fee_adjusted` and
  `destination_changed`. Intermediate steps fire their webhooks in order, exactly as in
  live: `created` → `collected` goes through `received`, `in_transit` and
  `ready_for_collection`. Returns go via `ready_for_collection` (not collected).
  Options: `exceptionType` (`lost` | `damaged`) with `to: "exception"`, and
  `destinationNodeId` with `to: "destination_changed"` (default: the nearest other Node).
  `fee_adjusted` needs a received parcel and raises the charge by 15% with a `measured`
  weight. An impossible move returns `409 INVALID_SIMULATION`; a live shipment
  `403 TEST_MODE_ONLY`.
- Test top-ups use Paystack's test cards.

---

## 14. Billing: wallet, pricing, invoices

- **Prepaid wallet**, one per mode. Top up by card in the dashboard (*Wallet › Top up*),
  or by **bank transfer to your dedicated account number** (live wallet; shown in
  *Wallet* once approved, credited automatically, usually within minutes). Card top-ups
  are credited minus the card processor's fee; bank transfers are credited in full. You
  get a `wallet.funded` webhook and an emailed receipt for each.
- **Hold, then charge.** Creating a shipment **holds** the quoted fee. When we receive the
  parcel, we **charge** the final fee: re-priced from where it was actually dropped and
  what we measured (`shipment.fee_adjusted` if different). Cancelled, expired or refused
  shipments release their hold. Nothing is charged.
- **Measured bigger than declared?** We charge the difference automatically. The parcel is
  never held up for money. If that takes your wallet below zero, existing parcels keep
  moving, but **new** shipments are refused (`402`) until you top up.
- **Volume discounts.** Your discount tier for the month is set by last month's live
  shipments that were collected or returned: 0% (0–499), 5% (500–4,999),
  10% (5,000–49,999), 15% (50,000+). Negotiated rates are available for large volumes.
- **VAT** is included in the price and shown in the fee breakdown.
- **Documents.** A monthly statement and tax invoice
  (`GET /invoices/{yyyy-mm}`, PDF/CSV), and a receipt for every top-up.
- **Low balance.** Set a threshold in the dashboard to get `wallet.low_balance` and an
  email.
- Wallet funds are prepaid service credit, used for Locoomo services. Unused balance is
  refunded to your verified bank account when you close your account.

### 14.1 Reading your wallet

Scope `wallet:read` (given to new secret keys by default). The key's mode picks the wallet.

**`GET /wallet`**

```json
{
  "mode": "live",
  "currency": "NGN",
  "balanceKobo": 5000000,
  "heldKobo": 360000,
  "availableKobo": 4640000,
  "updatedAt": "2026-11-15T10:05:00.000Z"
}
```

`availableKobo = balanceKobo − heldKobo` is what new shipments can use. `balanceKobo` can
be negative after a re-measure (see above).

**`GET /wallet/entries?type=&from=&to=&limit=&cursor=`**: your statement, newest first
(cursor pagination, §5.4). `from` is inclusive and `to` exclusive (ISO times).

```json
{
  "items": [
    {
      "id": "…",
      "type": "shipment_charge",
      "amountKobo": -180000,
      "balanceAfterKobo": 4820000,
      "description": "Shipment LCM-7K3M-Q9TD",
      "shipmentId": "0c7e5a7b-…",
      "createdAt": "2026-11-14T11:02:00.000Z"
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

| `type` | Meaning | Sign |
|---|---|---|
| `top_up` | Card or bank-transfer top-up | + |
| `shipment_charge` | A shipment's fee, charged when we received it | − |
| `shipment_adjustment` | Re-priced after we measured it | − (or + if it came out cheaper) |
| `adjustment` | A correction by Locoomo (approved by two Locoomo staff) | ± |
| `claim_credit` | An approved claim *(coming with claims)* | + |
| `refund` | Balance refunded to your bank account *(on closure)* | − |
| `test_funding` | Test mode only: the starting ₦1,000,000 and resets | ± |

New types may be added (§3).

**`GET /wallet/holds?status=active|captured|released&limit=&cursor=`**: fees set aside
for shipments, newest first: `{ id, shipmentId, status, amountKobo, capturedKobo,
createdAt, resolvedAt }`. `capturedKobo` is what was finally charged.

**`GET /wallet/top-ups?limit=&cursor=`** and **`GET /wallet/top-ups/{id}`**: card
payments and bank transfers, newest first:

```json
{
  "id": "…",
  "mode": "live",
  "method": "bank_transfer",
  "status": "succeeded",
  "amountKobo": 1000000,
  "feeKobo": 0,
  "creditedKobo": 1000000,
  "reference": "T1234567890abcd",
  "paidAt": "2026-11-15T09:30:00.000Z",
  "createdAt": "2026-11-15T09:30:04.000Z"
}
```

`method`: `card` or `bank_transfer`. `status`: `pending`, `succeeded`, `failed` or
`abandoned` (a card payment not completed within a day). `creditedKobo` is what reached
the wallet (`amountKobo − feeKobo`). Card top-ups themselves are started in the dashboard.

**`GET /wallet/funding-account`**: your live wallet's bank-transfer details, or `null`
before one is opened (and always in test mode):
`{ "bankName", "accountNumber", "accountName", "createdAt" }`.

**`POST /test/wallet/reset`** (test mode only, scope `shipments:write`): sets the test
balance back to ₦1,000,000 and returns the wallet. Holds for shipments not yet dropped off
stay. Live mode → `403 TEST_MODE_ONLY`.

---

## 15. Claims (lost or damaged parcels)

- `POST /claims` with `{ "shipmentId", "type": "lost" | "damaged" | "missing_item", "description", "evidence": ["…upload ids"] }`
  within **30 days** of the last status change.
- We investigate and decide (`claim.decided`). Approved claims are credited to your wallet:
  **the declared value, capped at ₦50,000** per parcel unless your contract says otherwise.
  Declare values accurately; insure high-value goods yourself.
- A parcel with no scan for 5 working days while in our custody is investigated
  automatically.
- Prohibited items (listed in the merchant terms) are refused at drop-off.

---

## 16. Errors

| HTTP | `error.code` | Meaning / what to do |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Fix the fields in `details` |
| 400 | `MALFORMED_JSON` | Body isn't valid JSON |
| 400 | `INVALID_IDEMPOTENCY_KEY` | Use 1–255 printable characters (a UUID) |
| 400 | `INVALID_CURSOR` | The pagination cursor was altered; restart the listing without it |
| 401 | `INVALID_API_KEY` | Unknown, revoked or expired key, or IP not allowed |
| 402 | `INSUFFICIENT_WALLET_BALANCE` | Top up; see `requiredKobo` and `availableKobo` |
| 403 | `INSUFFICIENT_SCOPE` | The key lacks the scope for this endpoint |
| 403 | `MERCHANT_NOT_APPROVED` | Live mode before approval |
| 403 | `MERCHANT_SUSPENDED` | Contact support. Reads still work and in-flight parcels continue |
| 404 | `NOT_FOUND` | Unknown id, or it belongs to the other mode |
| 409 | `DUPLICATE_REFERENCE` | `reference` already used; `existingShipmentId` included |
| 409 | `SHIPMENT_NOT_CANCELLABLE` | Already dropped off; use return-to-sender |
| 409 | `SHIPMENT_NOT_EDITABLE` | That field can't change in the current status |
| 409 | `SHIPMENT_NOT_RETURNABLE` | Return to sender only from `received` to `ready_for_collection` |
| 409 | `INVALID_SIMULATION` | (Sandbox) that move isn't possible from the current status |
| 403 | `TEST_MODE_ONLY` | (Sandbox) the simulator only works on test shipments |
| 403 | `LIVE_SHIPMENTS_NOT_AVAILABLE` | Live shipments aren't open yet; use test mode |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | Retry shortly with the same key |
| 413 | `PAYLOAD_TOO_LARGE` | Over 1 MB; use imports |
| 422 | `DESTINATION_NODE_UNAVAILABLE` | That Node isn't accepting parcels; pick another from `/nodes` |
| 422 | `ORIGIN_NODE_UNAVAILABLE` | The origin Node isn't available for drop-off |
| 422 | `RECEIVER_RELAY_NOT_ENABLED` | `notifyReceiver` `merchant`/`both` must be enabled on your account first |
| 422 | `NO_DELIVERY_OPTION` | Too big or heavy for any vehicle, or no courier covers the route |
| 422 | `ORIGIN_REQUIRED` | Quote without `originNodeId` and no hub assigned yet |
| 422 | `RECEIVER_UNREACHABLE` | Add `receiver.email`, or relay the code yourself |
| 422 | `IDEMPOTENCY_KEY_REUSED` | New request, new key |
| 422 | `INVALID_WEBHOOK_URL` | Use a public `https://` URL |
| 409 | `WEBHOOK_ENDPOINT_LIMIT_REACHED` | 5 endpoints per mode |
| 422 | `REPLAY_WINDOW_EXCEEDED` | Replays reach back 30 days at most |
| 422 | `CLAIM_WINDOW_CLOSED` | More than 30 days |
| 429 | `RATE_LIMITED` | Back off; honour `Retry-After` |
| 429 | `DAILY_LIMIT_REACHED` | Resets at midnight Lagos time; ask to raise it |
| 500 | `INTERNAL_ERROR` | Retry with the same `Idempotency-Key`; contact support with the `correlationId` if it persists |
| 503 | `MERCHANT_PLATFORM_DISABLED` | Temporary maintenance; retry later |

New codes may be added ([§3](#3-versioning-and-stability)). Handle unknown codes by HTTP
status.

---

## 17. Go-live checklist

The dashboard's *Home* shows these as a checklist (`GET /go-live-checklist`):

- [ ] Account **approved** (business details, CAC for businesses, owner/director ID, bank
      account, terms accepted; see below)
- [ ] **Two-factor authentication** on for the owner and admins
- [ ] **Live secret key** created and stored in your secrets manager, not in code
- [ ] **Live webhook endpoint** added, signature verification on, test event answered 2xx
- [ ] Dedupe on `webhook-id`; ignore lower `sequence`; ignore unknown event types and
      statuses
- [ ] `Idempotency-Key` on every POST, and retries reuse it
- [ ] **Wallet funded** (and low-balance alert set)
- [ ] At least one **test shipment simulated to `collected`**, and one to `returned`
- [ ] Hub assigned (bulk shippers) and labels printing correctly
- [ ] `trackingUrl` included in your order emails

**What approval needs** (submitted from the dashboard's onboarding checklist; reviews
usually take one working day):

| | Registered business | Individual seller |
|---|---|---|
| Business profile | Legal and trading name, category, contact email and phone, address, expected monthly volume | Your full name, the rest as for a business |
| CAC | RC or BN number + certificate | — |
| Identity | A director's government ID (NIN, international passport, driver's licence or voter's card) with a photo of it; up to 10 directors | Your own government ID |
| Settlement bank account | A Nigerian account, ideally in the business's name. We confirm the holder name with the bank | An account in your name |
| Terms | Merchant terms and Data Processing Agreement | Same |

If something needs fixing, we tell you which section and why; fix it and submit again.

Support: contact your Locoomo account manager. Include the `correlationId` from the
error or response.

---

## 18. Changelog

| Date | Change |
|---|---|
| 2026-11-14 | **Top-ups are live** (§14): card payments from the dashboard (test and live), and a dedicated bank-transfer account for the live wallet once approved. New: `GET /wallet/top-ups`, `/wallet/top-ups/{id}`, `/wallet/funding-account`, and the `wallet.funded` webhook. Card fees are deducted from what's credited; transfers are credited in full |
| 2026-11-14 | **Wallets are live** (§14.1): `GET /wallet`, `/wallet/entries` (your statement) and `/wallet/holds`, per mode. **The test wallet is now a real ledger**: a simulated drop-off charges it, re-measures adjust it, and `POST /test/wallet/reset` tops it back up to ₦1,000,000. **Fixed:** cursor pagination could skip rows (newest-first lists) or repeat them (`updatedSince` sync) when several rows shared a timestamp; cursors issued before the fix still work. Next: top-ups, then live shipments |
| 2026-11-14 | **Webhooks are live; the sandbox is complete.** Endpoints (API and dashboard), Standard Webhooks signing with 24-hour secret rolls, retries, auto-disable, replay, *Send test event* and the delivery log. Next: live shipments and the wallet |
| 2026-11-14 | **Test shipments and the simulator are live**: create (single and bulk), read, list and sync, timeline, edit, cancel, return to sender, and `POST /test/shipments/{id}/simulate`. `origin` is required until hubs open. Webhooks are next; imports and labels come with live shipments |
| 2026-11-14 | **Nodes and quotes are live**: `GET /nodes`, `GET /nodes/{id}` (now with `acceptingParcels`), `GET /quotes`, from your server or the buyer's browser with a publishable key. `originNodeId` is required on quotes until hubs open. Quote breakdowns show VAT as included, not added |
| 2026-11-14 | **API keys are live**: create test keys in *Developers › API keys* (live keys once approved), restrict them by IP or origin, roll and revoke them, and see every request in *Developers › API logs*. `GET /ping` checks a key. Rate limits apply as in §5.5. Nodes/quotes, test shipments and webhooks are next |
| 2026-11-14 | **Accounts and onboarding are live** in the merchant dashboard: create a business, invite your team with roles, complete KYC and submit for review. API keys, the sandbox, Nodes/quotes, test shipments and webhooks are next |
| 2026-11-12 | v1 contract published (Preview). Rollout order: accounts and onboarding → API keys, sandbox, Nodes/quotes, test shipments and webhooks → live shipments and wallet → hubs, manifests and bulk → reporting and claims |
