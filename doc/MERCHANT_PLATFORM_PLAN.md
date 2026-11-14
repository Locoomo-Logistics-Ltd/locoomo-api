# Merchant Platform — Plan (v2, consolidated)

Opening Locoomo to external merchants: marketplaces and integrators (Temu, AliExpress, Konga)
and individual or small-business sellers (Jiji).

Status: **approved direction; v2 consolidates all review findings**, 2026-11-12.

v2 changes from v1 came out of a line-by-line check against the code. Every claim about
existing behaviour cites the file it was verified in. Sections marked **⚠ gap closed** fix
something v1 got wrong or missed.

---

## 0. Decisions

### 0.1 Business decisions (owner-approved)

| # | Decision |
|---|---|
| D1 | **The buyer picks the destination Node** at the merchant's checkout, using Locoomo's Node and quote API with a publishable key. The shipment is created later, at fulfilment. |
| D2 | **Inbound.** Big integrators bulk-drop manifests at a **hub** Node. Small sellers drop at any Node. Warehouse pickup comes in a later phase. |
| D3 | **Prepaid merchant wallet.** Card top-up or bank transfer. Each shipment is paid from the wallet. |
| D4 | **v1 surface** is a REST API (test/live keys + webhooks) **and** the merchant dashboard API, including CSV upload. |
| D5 | **No COD, ever.** |
| D6 | **Returns** go back to the origin hub or Node, and the merchant collects them. |
| D7 | **Sandbox** uses Paystack-style test/live keys on one account. Test data never touches real Nodes, couriers or money. |
| D8 | **KYC.** Businesses provide CAC. Every merchant provides director/owner ID and a verified bank account. Individual sellers are allowed. Test keys work before approval. |
| D9 | **Volume discounts** off the standard rate card. |
| D10 | **SMS provider** sits behind a port. Without a valid key it goes silent (logged) and the flow continues on fallbacks. SMS is never a hard dependency. |
| D11 | **Bank-transfer top-ups** via Paystack Dedicated Virtual Accounts (DVA). |
| D12 | **Limits** are high and permissive: a safety net, not a gate. |
| D13 | **KYC review is manual** in v1. |
| D14 | **Re-measured parcels** are re-priced automatically. |
| D15 | **7 working days to collect.** If the destination Node is full or closed, the parcel still proceeds, an admin picks a nearby Node, and the buyer and merchant are notified. |
| D16 | **Backend ships APIs + docs only.** The frontend team builds every screen. |
| D17 | **Bag consolidation in v1.** The hub sorts parcels into one sealed bag **per destination Node**. There is one courier leg and one handover scan per bag (§7). |
| D18 | **Liability for lost or damaged parcels** is min(declared value, ₦50,000), credited to the wallet after an admin-reviewed claim. The cap is admin-editable per merchant. |
| D19 | **Buyers with no email or SMS.** Merchants can opt in to receive the collection code by webhook and relay it in their own app. Every Node also supports a counter fallback: name + phone last-4 + photo ID, operator-confirmed and audited. |
| D20 | **Abandoned returns.** 10 working days free, then a daily storage fee from the wallet. After 30 more days, with notices, Locoomo may dispose of the parcel under the merchant terms. The return trip itself stays free. |

### 0.2 Engineering decisions (made in v2, with reasons)

| # | Decision | Why |
|---|---|---|
| E1 | **Merchant access is membership-based, not a new `users.role`.** Any active non-admin user can create or join a merchant. Admins can never be members. | `users.role` is single-valued (`user.entity.ts`). A `merchant` role would stop existing consumers, riders and operators from joining a team. |
| E2 | **Wallet uses hold → capture.** A hold is placed at shipment creation and captured at intake at the *measured* price. It is released on cancel or expiry. | Cross-border parcels arrive weeks later. Charging at creation means refund churn for never-dropped shipments. D14 re-pricing becomes simply "capture at the measured price". |
| E3 | **Two capacity counters** (origin holds + destination holds) against one physical capacity, for **all** orders, consumer orders included. | Today only origin holds are counted (`nodes.service.ts:343-392`). Parcels waiting at a destination shelf are invisible, so "Node full" (D15) could never be detected. |
| E4 | **Origin rebinds at intake** for merchant parcels. Any active Node (or hub) may receive one. Origin and price are updated at capture. | Today intake 404s at any other Node (`confirm-drop-off.service.ts:32-35`). Sellers drop wherever is convenient and pallets land at the wrong hub. |
| E5 | **Orders emit a domain event on every transition.** The merchants module subscribes inside the same transaction. | The boundary rules stop orders, handoffs and logistics from importing merchants (`.dependency-cruiser.cjs`). Webhooks must stay transactional. |
| E6 | **No on-demand wallet withdrawals.** Unused balance is refunded only when an account closes (admin-approved). | Large withdrawable stored balances risk being treated as e-money or deposit-taking (CBN). Keeping it as "prepaid service credit" avoids that. Legal sign-off is still required (§15). |
| E7 | **Volume discounts are funded only from the platform share**, never from Node or rider shares, and are capped at the platform %. | Locoomo's commercial deals shouldn't cut Node operators' or riders' pay. |
| E8 | **Cursor pagination plus `updatedSince`** on merchant list endpoints. | Offset paging breaks while integrators sync at Temu volume. |
| E9 | **Keep UUIDs**, plus `?reference=` lookups. No prefixed ids. | Consistent with the rest of the API. `/:idOrReference` is ambiguous when a merchant's reference looks like a UUID. |
| E10 | **A worker process + Redis.** API and worker run as separate Railway services. Redis backs the throttler, auth caches and the session denylist. Cached values live only in Redis (no per-process copy), so a delete is visible to every instance immediately and no pub/sub busting is needed. Redis is optional for a single instance (in-memory fallback) and required before scaling out. | The outbox does about 60 messages/min per instance (`outbox.constants.ts`: batch 10, every 10s, sequential). Throttler and caches are per-process today, so revocation and rate limits break with more than one replica. |
| E11 | **CSRF goes `off → report → enforce`** via `CSRF_MODE`. Bearer-key requests and inbound webhooks are exempt. | Enforcing immediately would break every existing frontend. The check is missing today despite the comment in `session-cookies.ts`. |
| E12 | **Admin permissions**: `super`, `kyc`, `finance`, `ops`, `support`. Money moves (manual adjustments, claims, closure refunds) need a **second admin (maker-checker)**. | A single `admin` role would let one person approve KYC, view IDs and move money. |
| E13 | **Merchant API stability policy.** `/api/v1/merchant/*` only changes additively. Integrators must tolerate unknown fields, enum values and event types. Breaking changes go to `/v2` with 6 months of overlap and a `Sunset` header. | It's a public contract consumed by third parties. |
| E14 | **Test tracking codes are prefixed `LCT-`.** A Node scanning one gets a "test parcel" refusal, and public tracking ignores them. | Stops test labels leaking into real operations. |

---

## 1. Concepts

| Term | Meaning |
|---|---|
| **Merchant** | An organisation account (`business` or `individual`). It owns shipments, a wallet, keys and webhook endpoints. |
| **Member** | A user linked through `merchant_members` with a team role (owner, admin, developer, operations, finance, viewer). |
| **Mode** | `test` or `live`. Every merchant-owned row carries it. Live needs an `approved` merchant. |
| **Shipment** | The merchant-facing record (`merchant_shipments`). A live shipment links to one `orders` row, the physical parcel the Node, rider, courier, handoff and tracking code already understands. A test shipment is simulated inside the merchants module and never creates an order. |
| **Hold** | Wallet funds reserved for a shipment that hasn't been received yet (E2). |
| **Hub** | A Node flagged `isHub` by an admin. It receives bulk merchant inbound and sorts parcels into bags. |
| **Manifest** | A merchant's declaration of a batch it will drop at a hub. |
| **Bag** | A sealed container of parcels for **one** destination Node. It moves as one courier leg. |
| **Principal** | Who is calling: `user` (cookie session) or `api_key` (Bearer). |
| **Publishable key** `pk_…` | Browser-safe. Read-only access to Nodes and quotes. |
| **Secret key** `sk_…` | Server-only. Full merchant API within its scopes. |

---

## 2. End-to-end journeys

### 2.1 Merchant onboarding

```
Sign up (or existing account) ─► verify email ─► create merchant (business | individual)
     └─► test keys + test wallet immediately (integrate now)
Complete profile ─► KYC docs ─► bank account (Paystack resolve + name match) ─► terms ─► SUBMIT
Admin (kyc permission): accept/reject each item ─► approve (tier, limits, hubs, pricing)
                                               ├─► request changes (per-item reasons) ─► resubmit
                                               └─► reject (reason)
Approved ─► owner/admin enable 2FA ─► live keys ─► DVA issued ─► top up ─► go-live checklist
```

- **Merchant status**: `draft → submitted → in_review → approved | changes_requested | rejected`, plus `suspended` (reversible) and `closed`. Each transition emails the merchant. Submissions email the KYC admins.
- **Suspension**:
  - Blocks: new live shipments, new live keys, webhook endpoint changes.
  - Continues: in-flight parcels, webhooks, reads, top-ups (so debts can be cleared).
- **Closure** requires no parcels in flight, no returns awaiting collection and a balance ≥ 0. The remaining balance is refunded with maker-checker approval, and data retention follows §11.6.

### 2.2 Integrator (Temu-style)

```
CHECKOUT  buyer's browser → merchant's own picker → GET /merchant/nodes, GET /merchant/quotes (pk_live)
          merchant stores destinationNodeId on its order (quote is informational, §9.5)
FULFIL    POST /merchant/shipments (sk_live, Idempotency-Key) → HOLD placed, tracking code + label
          POST /merchant/manifests → manifest QR/PDF for the truck
HUB       scan manifest → scan each parcel (Locoomo code, merchant ref or merchant barcode)
          → captured at measured price → system says "Bag for <Node>" → seal bag
LINE-HAUL one courier leg per bag → destination Node scans the bag in → parcels shelved
          → buyer gets the code (SMS / email / merchant relay) → collects (code or ID fallback)
EXCEPTIONS
          uncollected after 7 working days → return leg → hub → merchant return batch
          Node full or closed → reroute queue → admin picks Node → buyer and merchant notified
```

### 2.3 Small seller (Jiji-style)

The seller uses the dashboard only: create a shipment (form or CSV). The destination is chosen
by the seller, or by the buyer through a **pick link** the seller shares on WhatsApp.
The seller writes the tracking code on the parcel or prints the label, then drops it at **any**
Node (E4). From there the flow is the same as above, without hubs or bags unless an admin
assigns them.

---

## 3. Authentication & authorisation

### 3.1 People (cookie sessions; extends the identity module)

Keep from today: scrypt, 15-minute access JWT, rotating refresh with family revocation,
lockout, hashed single-use tokens, enumeration-safe errors.

| Item | Design |
|---|---|
| Membership access (E1) | `MerchantGuard` + `@MerchantPermission('shipments.write')` resolve membership per request (Redis-cached 30s, busted on change). `RolesGuard` is untouched. |
| Email verification **enforced** | Required for all `/merchant/*` routes. Adds `POST /auth/verify-email/resend` (rate-limited). |
| TOTP 2FA | `POST /auth/mfa/totp/setup` → `/confirm`, plus 10 hashed recovery codes. Login (password **and** Google) returns `{ mfaRequired, mfaToken }` (5-minute single-use token), then `POST /auth/mfa/verify`. |
| Who must use 2FA | **All Locoomo admins, mandatory** (14-day enrolment grace after release). Merchant owner/admin before live keys. Optional for other members. |
| MFA recovery | A recovery code, or a support reset: admin `support` permission + identity check + audit entry + email to the user. The reset forces re-enrolment. |
| Step-up | `POST /auth/reauth` with password **or** TOTP **or** a fresh Google ID token (Google-only users have no password). Issues an access token with `reauthAt`, valid 10 minutes. Required for: live key create/roll, webhook URL change, bank account change, role changes, ownership transfer, closure. |
| Sessions | `refresh_tokens` gains `userAgent`, `ip`, `lastUsedAt`. New endpoints: `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/logout-all`. Access JWTs get a `sid` claim. Revoking a session puts the `sid` on a 15-minute Redis denylist, so revocation is immediate. Password reset or change revokes all sessions. |
| CSRF (E11) | All cookie-authenticated non-GET requests must carry `X-Locoomo-Client: web`, controlled by `CSRF_MODE=off\|report\|enforce`. Ships in `report` mode; flipped to `enforce` once the frontend team confirms. |
| CORS | `allowedHeaders` adds `X-Locoomo-Client`, `Locoomo-Mode`, `Idempotency-Key`. `exposedHeaders` adds the rate-limit and `Idempotent-Replayed` headers. |
| Dashboard origin | Must be same-site with the API (e.g. `merchant.locoomo.com`) because cookies are `SameSite=Strict`. |
| Merchant context | In v1 a user is a member of at most one merchant, so the merchant is implicit. The schema is many-to-many for future agencies. |

### 3.2 Machines (API keys)

| Aspect | Design |
|---|---|
| Format | `sk_live_` / `sk_test_` / `pk_live_` / `pk_test_` + 32 random bytes in base62. |
| Storage | SHA-256 hash only. `prefix` + `last4` kept for display. Shown **once**. |
| Lifecycle | Named keys per mode recording `createdBy`, `lastUsedAt`, `lastUsedIp` and optionally `expiresAt`/`revokedAt`. **Roll** adds a new key with an overlap window (now, 1h, 24h or 7d). **Revoke** takes effect immediately via a Redis bust. An "emergency: revoke all live keys" action exists. |
| Scopes | `shipments:read`, `shipments:write`, `manifests:write`, `webhooks:manage`, `wallet:read`, `claims:write`. The default is everything except `webhooks:manage`. Publishable keys are fixed to `nodes:read` + `quotes:read`. |
| Restrictions | Optional IP allowlist (CIDR) per secret key. Optional origin allowlist per publishable key. Publishable keys have a per-key "hide prices" option, so negotiated rates aren't revealed. |
| Transport | `Authorization: Bearer …` only. Keys in a query string are rejected with `401`. |
| Gates | Live keys need an approved merchant and owner/admin 2FA. Suspended merchant: live keys can read but writes get `403 MERCHANT_SUSPENDED`. |

**Guard integration.** `AuthGuard` detects `Bearer sk_|pk_` and authenticates the key into
`request.principal`, never `request.user`. As a result, `@Roles` routes and `@CurrentUser`
consumers automatically reject keys (`roles.guard.ts:26`). Any route without
`@AllowApiKey(scope)` returns `401` to a key.

**CORS for publishable keys.** `/api/v1/merchant/nodes*` and `/api/v1/merchant/quotes` are
excluded from the global credentialed CORS and get their own middleware: origin from the
key's allowlist (or `*` if none), no credentials, `Vary: Origin`.

### 3.3 Team permissions

| Permission | owner | admin | developer | operations | finance | viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| View shipments, returns, reports | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create/cancel/edit shipments, manifests, CSV, claims | ✓ | ✓ | ✓ | ✓ | | |
| Return-batch collection codes | ✓ | ✓ | | ✓ | | |
| API keys, webhooks, API logs | ✓ | ✓ | ✓ | | | |
| Wallet top-up, statements, invoices | ✓ | ✓ | | | ✓ | |
| Bank, KYC, profile, receiver-relay setting | ✓ | ✓ | | | | |
| Team management | ✓ | ✓ | | | | |
| Transfer ownership, close account | ✓ | | | | | |

Invites reuse the existing hashed invite tokens. An invitee with an existing account accepts
while logged in; a new invitee registers through the invite.

### 3.4 Rate limits (Redis-backed, E10)

| Caller | Default |
|---|---|
| `sk_live` | 50 req/s burst, 3,000/min |
| `sk_test` | 25 req/s |
| `pk_*` | 30 req/s per key + IP |
| Cookie session | the existing per-IP limits |

All limits are per merchant and admin-raisable. Responses carry `RateLimit-*` headers, and
the merchant routes' tracker replaces the global 100/min-per-IP default.

---

## 4. Onboarding, KYC & admin

### 4.1 Collected

| Item | Business | Individual | v1 verification |
|---|:-:|:-:|---|
| Legal/trading name, category, store URL, expected volume | ✓ | ✓ | manual |
| CAC RC/BN + certificate | ✓ | – | manual |
| Address, contact phone | ✓ | ✓ | phone OTP if SMS is configured; otherwise skipped |
| Owner/director: name, ID type (NIN, passport, driver's licence), number, image | ≥1 | ✓ | manual |
| Settlement bank account | ✓ | ✓ | Paystack resolve + name-match score; a mismatch is flagged to the admin |
| Owner BVN (only if Paystack requires it to create the DVA) | ✓ | ✓ | passed to Paystack and **never stored**; only the last 4 digits are kept |
| Terms + Data Processing Agreement acceptance | ✓ | ✓ | version + timestamp |

Uploads are signed direct-to-Cloudinary (`authenticated`); `CloudinaryService` moves to
`common/`. The server checks the upload exists before accepting it. Admins view documents
through signed URLs that expire in 5 minutes. **Every view is audited** (NDPA).

### 4.2 Tiers & limits (D12, admin-editable per merchant)

| | Individual | Business | Enterprise |
|---|---|---|---|
| Live shipments/day | 2,000 | 100,000 | unlimited |
| Wallet max balance | ₦50m | ₦2bn | unlimited |
| Negative-balance floor (§8.4) | −₦50k | −₦1m | custom |
| Hubs / bags | if assigned | yes | yes |

At 80% of a daily limit the merchant gets an email; at 100% new shipments get
`429 DAILY_LIMIT_REACHED`.

### 4.3 Admin review (`kyc` permission)

The queue is `GET /admin/merchants?status=`, oldest first, showing SLA age (target 1 working day).

| Action | Endpoint |
|---|---|
| Merchant detail | `GET /admin/merchants/:id` |
| Per-item decisions | `POST …/review` `{ items:[{ key, decision, reason? }] }` |
| Approve | `POST …/approve` `{ tier, limits?, hubNodeIds?, startingDiscountTier?, pricingOverride? }` |
| Request changes / reject | `POST …/request-changes`, `POST …/reject` (reason required) |
| Suspend / reinstate (`ops`) | `POST …/suspend`, `POST …/reinstate` |
| Receiver code relay (D19) | `PATCH …/settings` `{ receiverCodeRelay: true }`: requested by the merchant, approved by an admin |

Every action is written to `audit_events`. There is no impersonation; support uses a read-only
merchant 360 view (§10).

---

## 5. Order core changes (shared logistics; applies to consumers too)

### 5.1 Schema

- **`orders`**:
  - Make `consumerId`, `paymentIntentId` and `receiverEmail` nullable.
  - Add `source` (`consumer|merchant`), `merchantId`, `collectionDeadlineAt`, `rerouteState` (`none|pending|resolved`) and `bagId`.
  - Add a CHECK `(source='consumer' AND consumerId/paymentIntentId NOT NULL) OR (source='merchant' AND merchantId NOT NULL)`, created `NOT VALID` and then `VALIDATE`d (§11.7).
- **`nodes`**:
  - Add `isHub`, `acceptsMerchantDrops`, `merchantDestinationEnabled` and `merchantDailyArrivalCap?`.
  - Rename `currentCount` to `originHeldCount` (compatibility view kept during the deploy).
  - Add `destinationHeldCount`.

### 5.2 Capacity model (E3) ⚠ gap closed

Occupancy = `originHeldCount + destinationHeldCount`, measured against `capacity`.

| Event | Origin | Destination |
|---|---|---|
| Consumer intent created | +1 (refuse if full), as today | – |
| Merchant parcel received at Node/hub | +1 **forced** (never refuse a parcel at the counter) | – |
| Courier picks up (leg or bag) | −1, as today | – |
| Destination slot reserved at **dispatch** (leg or bag seal) | – | +1. If full, the parcel goes to the reroute flow (§6.5) |
| Collected / returned to origin | – | −1 |
| Return arrives at origin | +1 forced (`holdReturnedParcel`) | – |
| Return collected by sender | −1 | – |

- The picker (`findNearby`) offers only Nodes with destination headroom.
- `merchantDailyArrivalCap` limits how many merchant parcels per day a small Node accepts.
- The capacity audit (`capacity-audit-query.service.ts:57-90`) is rewritten to count from `orders` (source + status) for both counters, instead of joining `payment_intents`.

### 5.3 State machine additions ⚠ gap closed

The current graph is in `order-transitions.ts:3-23`. Additions:

| From | To | Trigger |
|---|---|---|
| `awaiting_drop_off` | `cancelled` | merchant cancel or auto-expiry. The hold is released; no capacity was held |
| `awaiting_drop_off` | `refused` (new) | Node refuses at intake (prohibited, damaged or unsafe; reason + photo). The parcel goes back to the person dropping it |
| `parcel_received_at_origin` | `return_initiated` | merchant intercept before dispatch |
| `ready_for_collection` | `return_initiated` | collection deadline passed (D15), or merchant intercept |
| any active | `exception` (new: lost or damaged, admin-set) | admin, with a claim opened automatically |

- A return from a destination shelf dispatches a **RETURN leg from the destination Node**. Its code is voided, its shelf is cleared and its destination slot is released.
- Returns travel in reverse bags when the origin is a hub (§7).

### 5.4 Collection codes & receiver contact (D19) ⚠ gap closed

- **Code TTL = the collection deadline**, not 60 minutes (`confirm-intake.service.ts:21`). Resending reissues the code (the old one is voided).
- **Channels**, all attempted, at least one required at shipment creation:
  1. SMS, if configured.
  2. Email, if present.
  3. Merchant relay, if approved. The code then appears in the `shipment.ready_for_collection` webhook.
  If none is possible, the API returns `422 RECEIVER_UNREACHABLE`; a buyer could still collect with the ID fallback, but would never learn the parcel had arrived.
- **Counter fallback**: `POST /handoffs/orders/:id/collect-with-id` with `{ collectorName, phoneLast4, idType, idLast4, photoPublicId? }`.
  - Operator only; 5 attempts per order.
  - Audited; the merchant is notified.
  - Recorded in the proof of delivery.
- **Proof of delivery** is stored and sent in `shipment.collected`: collector name, method (code or ID), time, Node, optional photo.
- **Sender contact resolver**: the consumer email, or the merchant's operations email + webhook. It replaces the `consumerId` lookups that would crash on merchant orders (`return-notification.service.ts:113-118`, `resend-collection-code.service.ts:100-110`).

### 5.5 Working days

Working days are Monday–Friday in `Africa/Lagos`, minus the admin-managed `public_holidays`.
The window length is the `COLLECTION_WINDOW_WORKING_DAYS` setting (7).

- Reminders go out on working days 5 and 6.
- The same window applies to consumer orders. This also resolves the open item E6 in `confirm-intake.service.ts:17-20`: uncollected consumer parcels return to the sender.

### 5.6 Domain events (E5)

`OrdersService.transition` and `appendEvent` publish `OrderStatusChanged { orderId, from, to, source, merchantId, occurredAt }`
through an in-transaction subscriber registry (same pattern as `DeliveryEventBus`). Subscribers:
- **merchants**: shipment status mirror + webhook events;
- **notifications**: buyer and sender messages;
- **nodes**: capacity counters.

---

## 6. Merchant shipments

### 6.1 Record

`merchant_shipments` columns:
- **Identity**: `id`, `merchantId`, `mode`, `merchantReference` (unique per merchant + mode), `externalBarcode?`, `orderId?`.
- **Status**: `status`, `sequence` (incremented on every change).
- **Route**: `originNodeId` (declared, rebindable), `destinationNodeId`.
- **Receiver**: `{ name, phone, email? }`, plus parcel attributes (`ParcelDetailsDto`).
- **Money**: `declaredValueKobo`, `holdId`, `feeKobo` (captured), `feeBreakdown`.
- **Grouping and metadata**: `manifestId?`, `metadata` (≤ 50 keys, ≤ 8 KB).
- **Timestamps**: `expiresAt`, `createdBy`, `createdAt`, `updatedAt`.

### 6.2 Merchant-facing statuses (stable, E13)

| Status | Meaning (internal source) |
|---|---|
| `created` | hold placed, awaiting drop (`awaiting_drop_off`) |
| `received` | at origin Node or hub, captured (`parcel_received_at_origin`) |
| `in_transit` | bagged or leg in progress (`rider_assigned`, `in_transit`, `arrived_at_destination`) |
| `ready_for_collection` | on the destination shelf |
| `collected` | done, with proof of delivery |
| `returning` | return in progress |
| `return_ready` | at origin, awaiting merchant collection |
| `returned` | merchant collected it |
| `cancelled` / `expired` / `refused` | terminal before receipt |
| `exception` | lost or damaged; see `exception.type` |
| `disposed` | abandoned return disposed of (D20) |

Sub-flags (not statuses): `rerouting: true`, `destinationChanged: true`.

### 6.3 Lifecycle rules

| Situation | Rule |
|---|---|
| Never dropped | Auto-expires after `SHIPMENT_DROP_DEADLINE_DAYS` (60 for hub/cross-border, 14 for Node drops). The hold is released and `shipment.expired` fires. |
| Cancel | Allowed while `created`. The order transition and hold release happen in **one transaction**, so it can't race intake: the loser gets `SHIPMENT_NOT_CANCELLABLE`. |
| Scanning a cancelled or expired parcel | Intake returns "Cancelled: hand back / set aside for merchant return". It's added to the merchant's return batch. |
| Intercept (buyer cancelled on Temu) | `POST /shipments/:id/return-to-sender`, allowed up to `ready_for_collection`. No extra fee in v1. |
| Edit | Receiver contact can change until `collected` (reissues the code, audited). Destination can change only while `created` (hold re-quoted). After that, only an admin reroute. |
| Wrong Node or hub (E4) | Intake at any eligible Node rebinds the origin. Capture uses the real origin and measurements, and the difference appears in `feeBreakdown`. |
| Refused at intake | `refused` with reason and photo. The hold is released; nothing is charged. |
| Suspended merchant | In-flight shipments continue normally. |

### 6.4 Endpoints (`/api/v1/merchant`; cookie session or API key)

All POSTs take `Idempotency-Key`. Lists use `?limit=&cursor=&updatedSince=` (E8).

| Method & path | Auth / scope | Purpose |
|---|---|---|
| `GET /nodes?near=lat,lng&radiusKm=&q=&state=&city=` | pk/sk/session | Picker: active, merchant-enabled Nodes with headroom, hours, distance |
| `GET /nodes/:id` | pk/sk/session | One Node |
| `GET /quotes?destinationNodeId=&parcelSize=&weightKg=&dims…&originNodeId?` | pk/sk/session | Indicative price (merchant discount applied unless the pk hides prices) |
| `POST /shipments` | `shipments:write` | Create + hold → `trackingCode`, `trackingUrl`, `labelUrl` |
| `POST /shipments/bulk` | `shipments:write` | ≤ 100 items, synchronous, per-item results |
| `POST /shipment-imports` | `shipments:write` | CSV/JSON up to 10,000 rows or 5 MB, **async** job → `GET /shipment-imports/:id` returns row-level results |
| `GET /shipments?status=&destinationNodeId=&manifestId=&createdFrom=&createdTo=` | `shipments:read` | List |
| `GET /shipments/:id` · `GET /shipments?reference=` | `shipments:read` | Detail |
| `GET /shipments/:id/timeline` | `shipments:read` | Merchant-safe events (no codes, rider PII or internal costs) |
| `PATCH /shipments/:id` | `shipments:write` | Edit, per §6.3 |
| `POST /shipments/:id/cancel` · `POST /shipments/:id/return-to-sender` | `shipments:write` | §6.3 |
| `GET /shipments/:id/label?format=a6\|a4` | `shipments:read` | PDF with Code128 + QR |
| `POST /label-batches` | `shipments:read` | Async multi-label PDF |
| `POST /manifests` · `GET /manifests/:id` · `POST /manifests/:id/close` | `manifests:write` | Hub drop batches (§7) |
| `GET /returns?state=` · `POST /return-batches` | session (ops) / sk | Returns queue; a batch issues a collection code |
| `POST /claims` · `GET /claims` | `claims:write` | Lost or damaged claims, within 30 days |
| `POST /test/shipments/:id/simulate` `{to}` | `sk_test` / test-mode session | Drives test shipments through every state, firing real (test) webhooks |
| `POST /pick-links` | `shipments:write` | Draft shipment + public token (§12) |
| Webhook endpoints, deliveries, replay | `webhooks:manage` | §9 |
| `GET /wallet`, `/wallet/entries`, `/wallet/holds`, `/wallet/statements/:month`, `/invoices/:month` | `wallet:read` / finance | §8 |
| `POST /wallet/top-ups` | session (finance) | Card top-up |
| `GET /reports/summary` · `POST /exports` | session | KPIs; exports stream CSV through a signed URL valid for 15 minutes, range ≤ 93 days |

**Dashboard-only (session)**: onboarding, profile, team, api-keys, bank account, settings,
audit log, API logs.

### 6.5 Reroute (D15) ⚠ gap closed

- **Checked** at origin/hub intake (early warning) and authoritatively when the destination slot is reserved at dispatch or bag seal. A Node deactivated or suspended while a parcel is in transit triggers it on arrival handling too.
- **While pending**, dispatch for that parcel is **gated**: it stays shelved at the hub or origin.
- **Admin queue (`ops`)**: `GET /admin/reroutes` shows the 3 nearest Nodes with headroom (PostGIS) and the queue age. `POST /admin/reroutes/:orderId { destinationNodeId, reason }` resolves one.
- **Fallback**: if no admin acts within **1 working day**, the system auto-picks the nearest Node with headroom and flags it for review. This keeps D15's admin decision while making sure a parcel never waits over a weekend.
- **After the decision**:
  - The new destination fee is recomputed, and Locoomo absorbs any difference.
  - The buyer is notified on every available channel.
  - The merchant gets `shipment.destination_changed`.
  - The code is reissued and dispatch is released.

### 6.6 Liability & claims (D18)

- Prohibited and restricted items are listed in the merchant terms; Node operators refuse at intake (§5.3).
- `POST /merchant/claims { shipmentId, type: lost|damaged|missing_item, description, evidence[] }` → admin (`ops`) investigates → decision.
  - An approved claim credits min(declaredValue, cap) to the wallet via maker-checker.
  - `exception` status plus `shipment.exception` / `claim.decided` webhooks.
- Lost: no scan for 5 working days while in custody → auto-flagged for ops, not auto-declared lost.

---

## 7. Hubs, manifests & bags (D17)

### 7.1 Manifests

1. The merchant creates a manifest `{ hubNodeId, expectedDropAt, shipmentIds[] }`. Shipments can be added until it is closed.
2. The hub sees `GET /node-operators/nodes/:hubId/manifests?status=expected` (paginated) instead of a flat to-receive list. The current flat list (`list-my-node-orders.service.ts`) can't hold 100k rows.
3. **Intake scan** `POST /handoffs/hub-intake { manifestId?, code }`. `code` resolves a Locoomo tracking code, `merchantReference` or `externalBarcode`, because cross-border parcels arrive with the merchant's own barcode. Keyboard-wedge (USB/Bluetooth) scanners and phone cameras both just send text. Each scan:
   - rebinds the origin (E4);
   - applies the measurements (optional fields, D14);
   - captures the hold;
   - moves the order to `parcel_received_at_origin`;
   - force-increments origin capacity;
   - **returns the sort instruction**: `{ bagCode, destinationNodeName }`.
   Scans are idempotent: a duplicate scan returns the same result.
4. `POST /handoffs/manifests/:id/complete` → `manifest.received { received[], missing[], unexpected[] }`. Unexpected parcels that resolve to the same merchant are accepted; unknown parcels go to an "unidentified" shelf for ops.

### 7.2 Bags: how parcels for different Nodes are kept apart

- **A bag has exactly one destination Node.** The system creates a bag the first time a parcel for that destination is scanned at the hub. Every later scan for the same destination gets the same bag code until the bag is sealed (manually, or automatically when it reaches `BAG_MAX_PARCELS` = 50 or the bag size class is full). So the hub never mixes destinations: the instruction on screen after each scan tells the operator which bag to use.
- **Seal** `POST /handoffs/bags/:code/seal`:
  1. Locks the bag's contents.
  2. Reserves **one destination slot per parcel** (E3). If the Node can't take them all, the parcels that don't fit are pulled out and go to the reroute queue before sealing.
  3. Creates **one delivery leg for the bag** (`delivery_legs.bagId`). The vehicle class comes from the bag's size and weight.
- **One trip, many bags**: a courier can take several bags to several Nodes. Each bag is still its own leg with its own handover code, so each Node scans only its own bag.
- **Handover**: one pickup code per bag at the hub, and one arrival code per bag at the destination. A leg status change fans out to every parcel in the bag (via the §5.6 events).
- **At the destination**: the operator scans the bag (bag arrived) and then each parcel as it's shelved. That mints the collection code and starts the 7-working-day clock.
  - Any parcel not scanned within 24h of the bag arriving → `missing_from_bag` alert to ops.
  - A parcel scanned at a Node it wasn't bagged for is flagged and forwarded as an individual leg.
- **Rerouted after sealing** (Node closed in transit): the bag is delivered to its Node as planned and the rerouted parcels are forwarded individually to the new Node. A sealed bag is never reopened at the hub.
- **Damaged bag**: the destination records the damage on the bag and scans what's inside; parcels not found → claims flow.
- **Reverse bags**: returns heading back to the same hub are bagged at their Node the same way.
- **Courier cost** is recorded per bag leg and allocated to its parcels pro rata for economics and earnings (the courier allocation per Sendii decision 8).

---

## 8. Wallet & money

### 8.1 Ledger

- **Tables**: `merchant_wallets` (per merchant + mode, cached `balanceKobo` and `heldKobo`), `wallet_entries` (append-only, signed), `wallet_holds` (`active|captured|released`).
- **Available** = balance − held. Holds and captures lock the wallet row (`FOR UPDATE`) in the same transaction as the shipment or order change.
- **Async bulk imports** reserve holds in chunks of 100 per transaction, so 10k rows don't serialise on one lock.
- **Nightly reconciliation**:
  1. Cached balance = Σ entries; held = Σ active holds.
  2. Paystack transactions per DVA customer = credited top-ups.
  Any drift alerts finance.

### 8.2 Top-ups ⚠ gap closed

- **`wallet_topups`**: a separate table, not `payment_intents`, whose shipment-shaped NOT NULL columns can't hold a top-up (`payment-intent.entity.ts`).
- **Card top-up**: Paystack checkout. The webhook credits the wallet **even if late**. Unlike shipment intents, a late top-up is never "expired out" (`handle-payment-webhook.service.ts:60-64`).
- **DVA**: one per merchant, created at approval. `charge.success` with `channel=dedicated_nuban` is routed by Paystack customer code to the merchant's wallet, idempotent on the Paystack transaction id. Today unknown references are logged and dropped (`:52-58`); that branch now hands off to the wallet router first. A periodic sweep pulls transactions per DVA customer to catch missed webhooks.
- **Fees**: card fees are deducted (net credited, shown on the receipt); DVA fees are absorbed by Locoomo (default, §15).
- **Test mode**: a fake wallet auto-funded with ₦1m, resettable. It can also use Paystack **test** keys for a realistic top-up flow (`PAYSTACK_TEST_SECRET_KEY`).

### 8.3 Pricing

- **Price** = the rate card (`pricing_rules`) for origin → destination + parcel attributes, minus the merchant's volume discount.
- **Discount tiers** (`volume_discount_tiers`, append-only, admin-editable): 0% / 5% / 10% / 15% at 0 / 500 / 5,000 / 50,000 shipments in the previous calendar month.
  - Counted: `collected` + `returned` + `return_ready`. Not counted: `cancelled`, `expired`, `refused`.
  - New merchants can be given a starting tier at approval.
  - `merchant_pricing_overrides` handles negotiated deals.
- **Funding (E7)**: the discount comes out of the platform share only and is capped at the platform %. Node, destination and courier shares are computed on the undiscounted fee.
- **Quotes are indicative.** The price is fixed when the hold is placed and finalised at capture (measured attributes + real origin).
- **VAT**: the fee breakdown shows a VAT component when `VAT_ENABLED` (7.5%, finance to confirm). Prices are quoted VAT-inclusive.
- **Documents**: a monthly statement + tax invoice per merchant (`/invoices/:month`, PDF + CSV), plus a receipt for every top-up.

### 8.4 Negative balance (from D14)

- Capture never blocks a parcel. Below zero, new shipments return `INSUFFICIENT_WALLET_BALANCE`.
- Below the tier floor (§4.2), ops is alerted and creation stays blocked; existing parcels keep moving.
- Low-balance warnings go out at a merchant-set threshold (`wallet.low_balance`).

### 8.5 Earnings

- A live merchant order writes `revenue_split_entries` at completion, the same way consumer orders do (`confirm-collection.service.ts:65`), computed from the **captured** fee (`orders.amountKobo` is updated at capture).
- Returned parcels: Node and courier shares are still earned for the forward leg actually performed, and the return trip's courier cost is recorded. The platform absorbs it (return trip is free, D20).
- Hub origin share applies as the origin Node.

### 8.6 Money controls (E12)

Manual adjustments, approved claims, closure refunds and storage-fee waivers all need two
admins (maker + checker) with the `finance` permission, plus a reason and an audit entry.

---

## 9. Webhooks

- **Endpoints**: up to 5 per mode. Each has a URL, an event list and a `whsec_` secret (shown once; rolling keeps both secrets signing for 24h).
- **SSRF guard, in both modes**:
  - Resolve DNS at send time and connect to the pinned IP.
  - Block private, loopback, link-local (169.254.0.0/16), CGNAT and IPv6 ULA ranges.
  - No redirects.
  - HTTPS required in live.
- **Signing**: Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,…`).
- **Payload**: `{ id, type, version: 1, mode, occurredAt, data: { shipment: <GET /shipments/:id snapshot at event time>, sequence } }`.
  - **No ordering guarantee.** Receivers keep the highest `sequence` per shipment. This is documented prominently.
- **Engine** (worker process, E10):
  - `webhook_events` rows are written in-transaction by the §5.6 subscriber; `webhook_deliveries` holds one row per endpoint.
  - Claims are per endpoint with **at most 4 in flight per endpoint**, plus a **circuit breaker**: after 20 consecutive failures the endpoint pauses for 10 minutes. One dead endpoint never stalls others.
  - 10s timeout. Retries at 5s, 1m, 5m, 30m, 2h, 5h, 10h, 10h, 10h (~1.5 days), then the delivery is marked `failed`.
  - **Auto-disable** when every delivery to an endpoint has failed for 36h. The owner and admins are emailed, and `POST /webhook-endpoints/:id/replay { since }` re-sends.
- **Retention**: logs keep request and response (4 KB each) for 30 days. `webhook_events` and `webhook_deliveries` are partitioned by month and dropped after 90 days.
- **Events**:
  - `shipment.created`, `shipment.updated`, `shipment.cancelled`, `shipment.expired`, `shipment.refused`
  - `shipment.received`, `shipment.in_transit`, `shipment.ready_for_collection` (+ `collectionCode` if relay is approved)
  - `shipment.collection_reminder`, `shipment.collected` (+ proof of delivery)
  - `shipment.destination_changed`, `shipment.fee_adjusted`
  - `shipment.returning`, `shipment.return_ready`, `shipment.returned`, `shipment.disposed`
  - `shipment.exception`
  - `manifest.received`
  - `claim.decided`
  - `wallet.funded`, `wallet.low_balance`
  - `merchant.status_changed`
- `POST /webhook-endpoints/:id/test` sends a signed `ping`.

---

## 10. Admin & operations APIs

| Area | Endpoints (permission) |
|---|---|
| Merchants | queue, detail/360 (profile, KYC, members, keys metadata only, wallet, webhook health, API logs, shipments), review actions (`kyc`/`ops`) |
| All orders | `GET /admin/orders` (`ops`/`support`). New: no admin order list exists today. Covers consumer and merchant orders, cursor pagination, filters (source, merchant, status, Node, dates, tracking code, reference) |
| Reroutes, exceptions, unidentified parcels | queues + actions (`ops`) |
| Hubs, manifests, bags | hub flags and assignments, manifest and bag views, missing-from-bag alerts (`ops`) |
| Money | wallets, entries, holds, manual adjustments (maker-checker), claims, closure refunds, unmatched DVA credits, reconciliation reports (`finance`) |
| Config | discount tiers, pricing overrides, public holidays, collection window, storage fee, liability cap (`super`) |
| Kill switches | `MERCHANT_PLATFORM_ENABLED` (global), per-merchant `creationPaused`, per-endpoint webhook pause (`super`/`ops`) |
| Health | `GET /admin/merchant-platform/health`: outbox and webhook lag, reroute queue age, KYC queue age, negative wallets, unmatched DVA, failing endpoints. Alerts are emailed to ops when thresholds are crossed |
| Audit | `GET /admin/audit-events` (`super`) |

---

## 11. Cross-cutting

### 11.1 Errors

The envelope is unchanged. New codes:
- **Account and auth**: `MERCHANT_NOT_APPROVED`, `MERCHANT_SUSPENDED`, `MERCHANT_PLATFORM_DISABLED`, `EMAIL_NOT_VERIFIED`, `MFA_REQUIRED`, `MFA_INVALID`, `REAUTH_REQUIRED`
- **API keys and mode**: `INVALID_API_KEY` (uniform 401), `INSUFFICIENT_SCOPE`, `IP_NOT_ALLOWED`, `MODE_MISMATCH`
- **Shipments**: `INSUFFICIENT_WALLET_BALANCE` (402, with `requiredKobo`/`availableKobo`), `DESTINATION_NODE_UNAVAILABLE`, `RECEIVER_UNREACHABLE`, `DUPLICATE_MERCHANT_REFERENCE` (409, with `existingShipmentId`), `SHIPMENT_NOT_CANCELLABLE`, `SHIPMENT_NOT_EDITABLE`
- **Requests and limits**: `IDEMPOTENCY_KEY_REUSED` (422), `DAILY_LIMIT_REACHED`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`
- **Ops**: `TEST_PARCEL`, `CLAIM_WINDOW_CLOSED`

Nested validation errors are flattened to `field: "receiver.phone"` / `"items[3].receiver.phone"`.
Today they're not (`validation-exception-factory.ts`).

### 11.2 Idempotency

`idempotency_keys` gains `requestHash`, `responseStatus`, `responseBody` and `expiresAt` (24h).
The scope is `merchant:<id>:<mode>`.
- Same body → stored response + `Idempotent-Replayed: true`.
- Different body → 422.
- A concurrent duplicate waits (or gets 409 `IDEMPOTENCY_IN_PROGRESS`).

`merchantReference` uniqueness is the business-level backstop.

### 11.3 Request handling

- **Body limits**: JSON 1 MB by default, 2 MB on `/shipments/bulk`, multipart 5 MB on imports. Today the express default of 100 KB applies (`bootstrap.ts`). Oversized requests get `413 PAYLOAD_TOO_LARGE`.
- **Times**: all timestamps are UTC ISO-8601; working days are computed in `Africa/Lagos`.
- **Mode for sessions**: the `Locoomo-Mode` header defaults to `test` when absent (safe default). A key always implies its own mode, and a conflicting header returns `MODE_MISMATCH`.
- **Heavy work runs in the worker as async jobs** with pollable status: imports, multi-label PDFs, exports, statements.

### 11.4 Throughput (E10)

- **Process split**: `PROCESS_ROLE=api|worker|all` (local default `all`). Pollers and `@Interval` jobs run only in the worker.
- **Outbox**: batch size, concurrency and interval come from env, and the outbox gets a per-event-type worker pool. Target: ≥ 50 messages/s per worker, scaled horizontally (`SKIP LOCKED` already supports it).
- **Redis**: throttler storage, membership/key caches (values held only in Redis, so deletes are instantly global), session denylist, distributed locks for singleton jobs.

### 11.5 Observability

- `merchant_api_requests` (keyId/principal, route, status, latency, correlationId; no bodies), partitioned daily and kept 14 days. It's visible to the merchant (API logs) and to admins.
- `helmet` added.
- Health metrics as described in §10.

### 11.6 Privacy & NDPA

- **Roles**: Locoomo is a processor for receiver data the merchant supplies, and a controller for its own notifications. The DPA in the merchant terms covers both, plus sub-processors (Cloudinary, email provider, SMS provider, Paystack, Sendii) and cross-border transfers.
- **Retention**:
  - Receiver PII on orders: redacted 180 days after the final state.
  - Proof-of-delivery photos: 180 days.
  - KYC documents: 5 years after the relationship ends; deleted 90 days after a rejection.
  - API and webhook logs: §9 and §11.5.
  - Test data: purged after 90 days.
  - Enforced by nightly jobs.
- **Access and redaction**: KYC and ID image views are audited, and `audit_events` before/after values have PII and secrets redacted.
- **Data-subject requests**: an admin endpoint to export or erase a receiver's data by phone or email (orders in flight are excluded until they finish).
- **Breaches**: a runbook with 72h NDPC notification, plus a check on whether NDPC "major importance" registration applies (§15).

### 11.7 Migrations

- Hand-written, as today.
- New CHECK constraints are added `NOT VALID`, then validated.
- Indexes on `orders` are built `CONCURRENTLY` in migrations with `transaction = false`.
- The column rename on `nodes` uses expand/contract (add new → dual-write → switch reads → drop).
- `ALTER TYPE … ADD VALUE` gets its own migration.
- Consumer DTO nullability changes (`paymentIntentId`, `receiverEmail`) are announced in `API.md`.

---

## 12. Frontend integration (backend deliverables only, D16)

1. **OpenAPI 3.1** (`@nestjs/swagger`) for `/merchant/*` and the admin merchant endpoints, served at `/api/v1/merchant/openapi.json`. CI fails if it drifts from the DTOs.
2. **Types**: frontend teams generate them with `openapi-typescript`. The docs include webhook verification snippets (Node, PHP, Python).
3. **Pick links (Jiji)**: `POST /merchant/pick-links` → token. Public `GET /pick/:token` (Nodes + quote, prices per merchant setting) and `POST /pick/:token { destinationNodeId }`. Expires after 7 days, single use, rate-limited.
4. **Docs**, in the existing `doc/` style, each written in the phase that ships the endpoints:
   - `doc/MERCHANT_API.md`, for integrators: 5-minute quick start, auth and keys, idempotency, errors, pagination and sync, webhooks, sandbox simulation, status table, stability policy, go-live checklist.
   - `doc/MERCHANT_DASHBOARD_API.md`, for the frontend team: screen → endpoints, full samples, TS types, UI copy, empty and error states.
   - `doc/MERCHANT_ADMIN_API.md`, for the admin frontend.
   - Additions to `doc/LOGISTICS_API.md` for the Node app: hub intake, bags, ID-fallback collection, refusals.
   - Postman collection generated from OpenAPI.
5. **Go-live checklist endpoint**: approved, 2FA on, live key created, webhook endpoint answered a test ping, wallet funded, a test shipment simulated to `collected`.

---

## 13. Data model summary

**New tables (merchants module unless noted):**
- **Accounts**: `merchants`, `merchant_members`, `merchant_directors`, `merchant_kyc_documents`, `merchant_bank_accounts`, `merchant_reviews`, `merchant_settings`.
- **API access**: `api_keys`, `merchant_api_requests`.
- **Shipments**: `merchant_shipments`, `shipment_imports`, `pick_links`, `claims`.
- **Hubs and returns**: `manifests`, `manifest_items`, `bags` (+ `orders.bagId`), `merchant_return_batches`.
- **Webhooks**: `webhook_endpoints`, `webhook_events`, `webhook_deliveries`.
- **Wallet and pricing**: `merchant_wallets`, `wallet_entries`, `wallet_holds`, `wallet_topups`, `merchant_dva_accounts`, `volume_discount_tiers`, `merchant_pricing_overrides`, `merchant_hub_assignments`.
- **Operations**: `exports`, `public_holidays` (orders).
- **Common**: `audit_events`.
- **Identity**: `mfa_factors`, `mfa_recovery_codes`.

**Changed tables:**
- `orders` (§5.1), `nodes` (§5.1).
- `delivery_legs`: `bagId`, nullable `orderId` for bag legs.
- `refresh_tokens`: `userAgent`, `ip`, `lastUsedAt`.
- `users`: `adminPermissions text[]`.
- `idempotency_keys` (§11.2).
- `handoff_codes`: bag codes and return-batch codes, via a nullable `bagId` / `returnBatchId` alongside `orderId`.
- `OrderStatus`: `cancelled` and `exception` reachable; new `refused`.

**Module layout:** a new `src/modules/merchants` (with `wallet/` and `webhooks/` sub-areas) that talks to other modules only through exported services and the §5.6 events. Bags and hub intake live in `handoffs` and `logistics`, because they're Node and courier operations, not merchant concepts.

---

## 14. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **M0 Foundations** | Redis; worker process split; outbox concurrency; CSRF (report mode); helmet; body limits; nested validation errors; `audit_events`; admin permissions + maker-checker primitive; email templates; **SMS port** (Termii + Noop, D10); Cloudinary to common; Principal + API-key hook in `AuthGuard`; idempotency with stored responses; order domain events (§5.6); OpenAPI scaffold | All existing e2e tests green; no behaviour change for current clients |
| **M1 Accounts & admin** | Enforced email verification, MFA (mandatory for admins), step-up, sessions; merchants, members, invites, permissions; onboarding + KYC + bank; admin review queue; suspension/closure semantics; kill switches; terms/DPA versions | A merchant self-onboards and gets approved end to end |
| **M2 Sandbox complete** | API keys + Redis rate limits + request logs; `/merchant/nodes`, `/quotes` with pk CORS; shipment API contract with the **test** backend (`LCT-` codes); **webhook engine** + simulator; MERCHANT_API.md v1 | An integrator builds the full integration against test mode |
| **M3 Logistics core** (consumer orders benefit too) | Two-counter capacity + audit rewrite; order schema changes; state additions (cancel, refuse, intercept, exception, collection expiry → return from destination); code TTL = deadline; working days + holidays + reminders; ID-fallback collection + proof of delivery; sender-contact resolver; origin rebind; merchant return batches | Every return/expiry path has an e2e test, including merchant order + courier failure → returned |
| **M4 Live shipments & money** | Wallet holds/capture, ledger, reconciliation; card top-up + DVA + sweep; live create/bulk/import/cancel/edit/intercept; labels (pdfkit + bwip-js); pricing + discounts (E7) + VAT flag; invoices/statements; receiver relay; claims; negative floor; earnings wiring | **First live merchant (Node drop-off)** |
| **M5 Hubs, manifests, bags** | Hub flags/assignments; manifests; hub intake with code resolution + sort instructions; bags, seal, bag legs, bag handover, destination unbag, missing-from-bag; reroute queue + 1-working-day fallback; per-Node merchant arrival caps; reverse bags | **Temu-scale inbound**; load test at 100k parcels/day through one hub |
| **M6 Ops & compliance** | Admin all-orders, merchant 360, health + alerts, exports, reports; abandoned returns (storage fees, disposal); retention/redaction jobs; data-subject export/erase; partitions | Ops runbook complete |
| **M7 DX polish** | Pick links; Postman; final doc pass; go-live checklist | Docs reviewed by the frontend team |

- **Parallelism**: M1 ∥ M3 after M0. M2 needs M1's merchants. M4 needs M2 + M3. M5 needs M4. M6 can start after M4.
- **Go-live gates**: the first live merchant needs M0–M4. Hub/bag integrators (Temu) need M5. Abandoned-return fees can't be charged before M6, so until then returns are free and ops chases them manually.

---

## 15. Defaults to confirm (finance, legal, ops)

None of these block the build. They're config values or terms text.

| # | Default | Owner |
|---|---|---|
| F1 | Volume tiers 0/5/10/15% at 0/500/5k/50k per month | commercial |
| F2 | Card top-up fees passed through (net credited); DVA fees absorbed | finance |
| F3 | VAT 7.5%, prices VAT-inclusive, monthly tax invoice; WHT handling for corporate merchants | finance/tax |
| F4 | Storage fee for abandoned returns: ₦100 per parcel per day after 10 working days; disposal after 30 more days | ops |
| F5 | Liability cap ₦50,000; 30-day claim window; prohibited-items list | legal/ops |
| F6 | Wallet as non-withdrawable prepaid service credit (refund only on closure). **Needs legal sign-off re CBN** | legal |
| F7 | Data retention periods in §11.6; NDPC registration check; DPA text | legal/DPO |
| F8 | Whether Paystack DVA needs the owner's BVN for these merchants | finance (Paystack account manager) |
| F9 | SMS sender ID "Locoomo" with the merchant name in the message body; SMS cost absorbed | commercial |

---

## 16. Lessons from pod-ng (reference, unchanged in substance)

pod-ng had:
- plaintext tokens, BVN and passwords;
- non-expiring mobile tokens;
- activation "codes" that were passwords;
- self-promotion to admin by email suffix;
- a hardcoded admin key in GET URLs;
- unauthenticated carrier webhooks and PII exports;
- mass-assignment of passwords;
- social login auto-linking accounts by email;
- inconsistent error shapes;
- unaudited `loginAs`;
- no pagination;
- approval with no reject.

Every one is addressed above: hashed secrets shown once, short-lived rotating sessions, hashed
single-use tokens, admin by invite with MFA and permissions, signed and verified webhooks,
authenticated expiring exports, whitelisted DTOs, no auto-linking, one error envelope, no
impersonation, cursor pagination, and a full review flow.

Kept: status history with the actor (`order_events`), forward-only courier status (leg state
machine), per-endpoint webhook secrets, and explicit response DTOs.

---

## 17. Progress

### M0 Foundations: done (2026-11-12)

What shipped, where:

| Item | Where |
|---|---|
| Redis (optional; in-memory fallback), shared cache, Redis rate-limit storage | `src/common/redis/` |
| `PROCESS_ROLE=api\|worker\|all` gate for every background job | `src/common/process/background-jobs.ts` |
| Outbox: configurable interval/batch/concurrency, drains backlogs (defaults 2s / 50 / 10) | `notifications/application/outbox-poller.service.ts` |
| CSRF header guard, `CSRF_MODE` (default `report`) | `src/common/auth/csrf.guard.ts` |
| helmet; 1 MB body limit; body-parser errors → `PAYLOAD_TOO_LARGE` / `MALFORMED_JSON`. This also fixes a pre-existing bug where an oversized body returned 500 | `src/bootstrap.ts`, `src/common/http/body-parser-errors.ts` |
| Nested validation paths (`items[3].receiver.phone`) | `src/common/pipes/validation-exception-factory.ts` |
| Audit log with secret/PII redaction | `src/common/audit/` |
| Admin permissions (`super/kyc/finance/ops/support`), `@RequireAdminPermission`, `GET/PATCH /admin/admins` | `identity/application/admin-permission.service.ts` |
| Maker-checker approvals: registry + service + `/admin/approvals` queue. The DB check constraint forbids self-approval | `src/modules/admin/` |
| Email layout (`renderEmail`) | `notifications/application/email-template.ts` |
| SMS port: Termii + no-op; skips silently without a valid key (D10) | `notifications/infrastructure/*sms*` |
| Cloudinary moved to common | `src/common/cloudinary/` |
| `Principal`, `@AllowApiKey(scopes)`, API-key hook in `AuthGuard` (M2 plugs in the key store) | `src/common/auth/` |
| `Idempotency-Key` replay interceptor + expiry cleanup | `src/common/idempotency/` |
| Order status events (in-transaction bus) | `orders/application/order-status-event-bus.ts` |
| Merchant OpenAPI at `/api/v1/merchant/openapi.json` + `npm run openapi:generate` | `src/openapi/` |
| Migrations 354–356 (audit, admin permissions + approvals, idempotency replay) | `src/database/migrations/` |

Deferred on purpose:
- Moving existing inline emails onto the template happens as each is touched.
- The CI OpenAPI drift check is added in M2, when the first `/merchant` routes exist.

**Rollout notes:**
1. Every existing admin is granted `super` by migration 355. Narrow permissions from the admin screen afterwards.
2. Frontends must add `X-Locoomo-Client: web` to non-GET requests. Flip `CSRF_MODE=enforce` once the "[CSRF report]" log lines stop.
3. Run separate `api` and `worker` services and set `REDIS_URL` before scaling to more than one API instance.

### M1a Account security: done (2026-11-12)

Applies to every user, not only merchants.

| Item | Where |
|---|---|
| TOTP 2FA (in-house RFC 6238, tested on the RFC vectors). Seeds sealed with AES-256-GCM (`DATA_ENCRYPTION_KEY`), replay-protected, 10 hashed recovery codes | `identity/domain/totp.ts`, `identity/application/mfa.service.ts`, `common/crypto/secret-box.ts` |
| Login and Google return `{ mfaRequired, mfaToken }` for 2FA accounts; `POST /auth/mfa/verify` (5-minute token, 5 attempts) | `identity/application/session-starter.service.ts` |
| Sessions = refresh-token families: list, revoke one, revoke others. `sid` claim + denylist, so revocation is immediate (also on logout, refresh-token theft and password reset) | `identity/application/session.service.ts`, `common/auth/session-denylist.ts` |
| Step-up `POST /auth/reauth`: 2FA code when on, else password, else Google. `@RequireRecentAuth()` (10 min) | `identity/application/reauth.service.ts` |
| `@RequireVerifiedEmail()`, `POST /auth/verify-email/resend` | `identity/interface/account-state.guard.ts` |
| Mandatory admin 2FA: 14-day grace from invite, or from migration 357 for existing admins | `users.mfaRequiredSince` |

**Rollout:**
1. Set `DATA_ENCRYPTION_KEY` in every environment **before** anyone enrols, and never change it afterwards.
2. Existing admins have 14 days from deploy to turn on 2FA.
3. Frontends must handle the `mfaRequired` login response and the `REAUTH_REQUIRED` retry flow (doc/API.md › Account security).

### M1b Merchant accounts, onboarding & review: done (2026-11-14)

M1 exit criterion met: a merchant self-onboards and gets approved end to end
(`test/merchants/merchant-onboarding.e2e-spec.ts`).

| Item | Where |
|---|---|
| `merchants` module: accounts, members (one merchant per user, one owner per merchant), invites, directors, documents, bank account, per-section review items. Migration 358 | `src/modules/merchants/` |
| Status machine + editability rules (frozen under review; identity details locked after approval) | `merchants/domain/merchant-status.ts` |
| Team roles → permissions (§3.3), `MerchantGuard` + `@MerchantAccess(permission)`, membership cached 30s and busted on change | `merchants/domain/merchant-permissions.ts`, `merchants/interface/merchant.guard.ts` |
| Onboarding checklist per type; editing a section clears the reviewer's verdict on it | `merchants/domain/onboarding-checklist.ts` |
| KYC files: signed uploads into `merchants/<id>/kyc`, ownership + existence checked; admins get 5-minute links; every view audited | `merchant-account.service.ts`, `admin-merchants.service.ts` |
| ID numbers and bank account numbers sealed (`merchant-kyc`, `bank-account` boxes) | |
| Bank account via Paystack resolve + name-match score (strong/partial/weak) | `merchants/domain/name-match.ts` |
| Team invites by email (7 days, hashed single-use token, public preview, accept with the invited address only), role change and ownership transfer with step-up, leave | `merchant-team.service.ts` |
| Admin queue and decisions (`kyc`), suspend/reinstate/settings (`ops`), list/detail also for `support` | `admin-merchants.controller.ts` |
| Emails: submission (team + KYC admins), approved, changes requested (per-section reasons), rejected, suspended, reinstated, closed, bank change, invites, team changes | `merchant-notifier.service.ts` |
| Kill switch `MERCHANT_PLATFORM_ENABLED` (503 on `/merchant/*`, admin routes unaffected) | `merchant.guard.ts` |
| `error.details` on business errors (e.g. `ONBOARDING_INCOMPLETE` sections) | `common/exceptions/app.exception.ts` |

Decisions made while building (within the plan's intent):

- **Own invite table, not identity's.** Identity invites create `INVITED` users with an
  admin-set role; merchant invitees are often existing users. The invitee signs in (or
  signs up and verifies) with the invited address, then accepts.
- **Approve accepts undecided sections**; it refuses while any section is rejected.
  Request-changes needs at least one rejected section, so the merchant always learns what to fix.
- **Closure** removes the team and revokes invites, and is open to the owner from `draft`,
  `changes_requested`, `approved` and `rejected`. M4 must add the in-flight, balance and
  refund checks (§2.1) before live shipments exist.
- **Deferred:** phone OTP on the contact number (SMS optional, D10), hub assignments and
  pricing on approve (M4/M5), the merchant 360 view (M6), the `Locoomo-Mode` header (M2).

**Rollout:**
1. Set `MERCHANT_DASHBOARD_URL` (e.g. `https://merchant.locoomo.com`) and add that origin to `CORS_ORIGIN`.
2. Give the KYC reviewers the `kyc` permission (submissions email every active `kyc`/`super` admin).
3. Legal: publish the merchant terms + DPA text for version `2026-11-14`
   (`merchants/domain/merchant-terms.ts`). Bump the constant whenever the text changes.

### M2a API keys: done (2026-11-14)

M2 ships in slices: **M2a keys** → M2b Nodes and quotes → M2c test shipments + simulator → M2d webhooks.

| Item | Where |
|---|---|
| `api_keys` (SHA-256 hash only, prefix + last4), `merchant_api_requests`. Migration 359 | `merchants/infrastructure/entities/` |
| Key format `sk_/pk_` + `test/live` + 43 base62 chars; scopes, defaults (all but `webhooks:manage`); every key gets `nodes:read` + `quotes:read` | `merchants/domain/api-key.ts` |
| Authenticator registered into AuthGuard: lookup cached 30s (revoke/roll/edit bust it), revoked/expired/closed/rejected → 401, live keys only for approved/suspended merchants, IP (CIDR v4/v6) and origin allow-lists, suspended live writes → `403 MERCHANT_SUSPENDED` | `api-key-authenticator.service.ts` |
| Per-key rate limits on the shared throttler storage (live 3,000/min + 50/s, test 25/s, pk 30/s per key per IP) with `X-RateLimit-*`; 30 bad keys/min from one IP → 1-minute block. Global per-IP throttler skips API-key requests | `api-rate-limiter.ts`, `common/common.module.ts` |
| Dashboard: list, create (secret shown once), edit, roll with overlap (now/1h/24h/7d), revoke, revoke-all; live keys need approval, 2FA on caller and owner, step-up | `api-key.service.ts`, `api-keys.controller.ts` |
| Request log per key request (metadata only), dashboard list with cursor pagination, 30-day purge job | `api-request-log.service.ts` |
| `GET /merchant/ping` for integrators | `api-keys.controller.ts` |
| Publishable-key CORS: open, no credentials, on `/merchant/{nodes,quotes,ping}` only | `bootstrap.ts` |
| Cursor pagination helper (`{items, nextCursor, hasMore}`) | `common/pagination/` |
| Step-up check moved to `common/auth/recent-auth.ts` (conditional step-up for live keys) | |

Also fixed: **Express `trust proxy` was never set**, so behind Railway `request.ip` was the
proxy for every user. All users shared the per-IP limits (including 5 logins/min), and audit
logs recorded the proxy IP. Now `TRUST_PROXY_HOPS` (default 1 on Railway, else 0).

Deferred: per-merchant raised rate limits (admin) and API-key-aware dashboard requests
(`Locoomo-Mode`) arrive with M2b/M2c.

**Rollout:**
1. After deploy, check an `audit_events` row's `ip` is a real client IP, not Railway's. If
   not, set `TRUST_PROXY_HOPS` explicitly.
2. Set `REDIS_URL` before running more than one API instance (key cache, rate limits).

### M2b Nodes and quotes: done (2026-11-14)

| Item | Where |
|---|---|
| `GET /merchant/nodes` (near/radius, q, state, city, cursor) and `/nodes/{id}` (`acceptingParcels`), via a plain-data `NodesService.searchAvailable/getAvailable` | `merchant-catalog.service.ts`, `nodes/application/nodes.service.ts` |
| `GET /merchant/quotes` through checkout's `DeliveryQuoteService` (same price logic); merchant breakdown, VAT shown as included when `VAT_ENABLED`, `hidePrices` for publishable keys | `merchants/domain/merchant-quote.ts` |
| Any key, or a dashboard session of any member; open CORS for publishable keys (M2a) | `merchant-catalog.controller.ts` |
| Public OpenAPI: real schemas (generated from the compiled build so the Swagger plugin runs) and only the schemas public paths reference | `src/openapi/openapi.ts`, `npm run openapi:generate` |

Decisions:
- **Origin is required on quotes until hubs exist (M5)**: `422 ORIGIN_REQUIRED`. M5 makes it
  default to the merchant's hub.
- **`parcelSize` on `/nodes` is accepted but doesn't narrow results yet**: capacity is per
  parcel. The two-counter capacity model (M3, E3) can refine this.
- **VAT**: prices stay VAT-inclusive; `VAT_ENABLED` (default off) only itemises the included
  VAT. The contract's sample was corrected (VAT was shown as added on top). Finance confirms F3.

### M2c Test shipments and simulator: done (2026-11-14)

| Item | Where |
|---|---|
| `merchant_shipments` (receiver, parcel, Node snapshots, fee hold/charge, collection, return, exception; `UQ(merchantId, mode, reference)`; test codes must be `LCT-`) and `merchant_shipment_events` (history + `sequence`). Migration 360 | `merchants/infrastructure/entities/` |
| Status machine, simulator paths, working-day collection deadline (Lagos, Mon–Fri), test tracking/collection codes | `merchants/domain/shipment.ts` |
| Create (idempotent, duplicate reference → 409 with the existing id, receiver reachability, relay opt-in, priced through checkout's quote), bulk (per-item validation and errors), get, list (cursor; `updatedSince` oldest-first), timeline, PATCH (receiver until collected; route and parcel while created, re-quoted), cancel, return to sender | `merchant-shipment.service.ts`, `shipments.controller.ts` |
| Simulator: walks every intermediate status, plus `fee_adjusted`, `destination_changed` (nearest other Node), `exception` | `shipment-simulator.service.ts` |
| Every change: `sequence` +1 and an event row in the same transaction, then listeners (webhooks hook in here in M2d; the relayed collection code is passed to listeners, never stored) | `shipment-events.service.ts` |
| `@MerchantApi(scope, permission)`: one route for API keys and dashboard sessions; sessions choose the mode with `Locoomo-Mode` | `merchant.guard.ts` |
| Sandbox wallet: ₦1,000,000 of holds → `402 INSUFFICIENT_WALLET_BALANCE` | `merchant-shipment.service.ts` |

Decisions:
- **Origin is required** (`{type:"node"}`) until hubs exist (M5), same as quotes; the
  quick start was updated.
- **Live shipping returns `403 LIVE_SHIPMENTS_NOT_AVAILABLE`** until M4 (orders, wallet,
  labels). Live reads work and are empty.
- **Deferred to M4:** shipment imports (CSV/10k), labels, the test-wallet reset, the
  drop-deadline expiry job, live `trackingUrl`.

### Documentation

- **[MERCHANT_API.md](MERCHANT_API.md)** is the public v1 contract for integrators (Preview).
  Where it is more specific than this plan, it wins: response shapes, the cursor format,
  `notifyReceiver` values, shipment drop deadlines, error codes, and webhook signing per
  Standard Webhooks with a base64 `whsec_` secret. Each phase must ship exactly what it
  documents, or update it.
- **[FRONTEND_PLATFORM_GUIDE.md](FRONTEND_PLATFORM_GUIDE.md)** covers the Locoomo frontend
  team's changes, account-security screens, the admin app and the merchant dashboard
  roadmap.
- **[API.md](API.md)** is the per-endpoint reference for everything live.

## 18. Delivery approach

Code accumulates phase by phase on `dev`. Each phase lands as reviewable commits with code,
migrations, unit and e2e tests **and** that phase's docs. A phase is done only when CI is green
(typecheck, lint, boundaries, build, unit, migrations, e2e) and its exit criteria in §14 are met.
