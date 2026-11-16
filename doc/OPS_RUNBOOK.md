# Locoomo operations runbook (merchant platform)

For Locoomo operations, support, finance and engineering on call. What to watch, what
each alert means, and the step-by-step for the situations that come up. Admin screens
are in the admin app; the API paths are given so engineering can check behind them.

*Last updated: 16 November 2026 (M6d).* Owner: Head of Operations. Engineering
co-owns §6–§7.

---

## 1. The shape of the system

| Piece | What it does |
|---|---|
| **API** (`locoomo-api`, `PROCESS_ROLE=api`) | Serves the apps and the merchant API |
| **Worker** (`PROCESS_ROLE=worker` or `all`) | Every background job: emails/SMS (outbox), merchant webhooks, courier polling, top-up sweep, collection reminders and returns, bag and reroute sweeps, storage fees, platform health, retention |
| **Couriers** | Sendii (external, carries bags) and Locoomo riders (in-house) |
| **Payments** | Paystack: card top-ups and bank-transfer accounts (DVA) |
| **Files** | Cloudinary (private): KYC documents, counter photos, claim evidence |

If the worker is down, nothing breaks for users immediately, but emails, webhooks,
reminders and sweeps stop: the **Platform health** page shows it within minutes (§2).

**Environments:** production `api.locoomo.com`; staging `api-loccomo.up.railway.app`
(Railway). Changes go `dev` → `staging` (PR) → `main` (production).

**Admin roles:** `super`, `kyc`, `finance`, `ops`, `support`. Money moves need **two**
`finance` admins (one requests, another approves in *Approvals*).

---

## 2. Daily routine (ops)

1. **Platform health** (Admin › Platform health, `GET /admin/merchant-platform/health`):
   everything green? Red checks are also emailed (§3).
2. **Queues:** merchant review (KYC), Reroutes, Claims, Approvals.
3. **Bags:** any `sealed` for over 30 minutes without a courier, or flagged missing parcels.
4. **Abandoned returns:** the "disposed" emails list parcels to remove from Nodes.

---

## 3. Alerts and what to do

Ops (and `super` admins) are emailed when a check goes red, reminded every 6 hours while
it stays red; it closes by itself when it clears.

| Check | Red when | First steps |
|---|---|---|
| **Outbox lag** | Oldest due email/job > 15 min | Worker running? (Railway logs: "outbox"). Restart the worker service. If emails fail at the provider, check `SMTP`/Resend status |
| **Outbox failures (24 h)** | Any job failed for good | Engineering: read `lastError` on the failed rows; fix the cause; failed rows aren't retried automatically |
| **Webhook lag** | Oldest due merchant webhook > 30 min | Worker running? A single merchant endpoint failing doesn't delay others (it's isolated); a global lag means the worker is behind |
| **Failing webhook endpoints** | (information) | Merchant 360 › Webhooks. Endpoints failing 36 h are disabled and the merchant is emailed; nothing for us to do unless they ask |
| **Reroute queue age** | Oldest waiting parcel > 4 h | Admin › Reroutes: pick a Node (§4.3). After a working day the system picks for you |
| **KYC queue age** | Oldest application > 48 h | Admin › Merchants queue: review the oldest first |
| **Negative live wallets** | (information) | Merchant 360 › Wallet. Below the tier floor, finance is emailed; new shipments are already refused until a top-up |
| **Sealed bags without courier** | Any sealed > 30 min with no courier | §4.5 |
| **Parcels missing from bags** | Any bag with parcels unscanned 24 h after arrival | §4.6 |

---

## 4. Procedures

### 4.1 A merchant is causing trouble

- **Pause new shipments** (keeps parcels in flight moving): Admin › Merchant › Settings
  › "Pause new live shipments" (`creationPaused`).
- **Suspend** (blocks live activity; parcels in flight continue; team emailed): Merchant
  › Suspend, with a reason. Reinstate returns them to their previous status.
- **Everything at once** (platform-wide incident): set `MERCHANT_PLATFORM_ENABLED=false`
  on the API service. Every `/merchant` route answers `503`; admin screens keep working.

### 4.2 Money

- **Top-up paid but not credited:** the sweep re-checks pending payments every 15 min.
  Merchant 360 › Wallet › Top-ups: if still `pending`, the merchant can open it (status
  check). Never credit by hand without the Paystack reference: use a wallet adjustment
  (two finance admins) quoting it.
- **Wallet doesn't add up:** the nightly reconciliation emails finance on any drift.
  Engineering investigates; corrections are adjustments (two-admin), never DB edits.
- **Storage fee dispute:** refund with a wallet adjustment (credit), reason "storage fee
  waiver: <tracking code>".
- **Claims:** Admin › Claims. Reject with a reason (one admin), or raise a payout (finance)
  for a second finance admin to approve. Payout ≤ the claim's `maxPayoutKobo`.

### 4.3 A destination Node is full or closed

Parcels dropped off for it wait at their origin (Admin › Reroutes). Pick one of the
three nearest Nodes with room ("Send here"). The buyer is emailed, the merchant gets a
webhook, Locoomo absorbs any price difference. **Parcels already on their way to a Node
that just closed aren't rerouted automatically:** find them in All orders (filter by
destination, status `in_transit`), and handle with the Node / courier.

### 4.4 Lost or damaged parcel

All orders › the parcel › "Lost or damaged" (`ops`). The order stops, its capacity is
released, the sender is told and, for a merchant parcel, a claim opens automatically.

### 4.5 Courier problems

- **A delivery never reached the courier:** Admin › Logistics › Deliveries, filter
  "stuck"; **Retry**.
- **Courier outage (Sendii):** single parcels: **Fallback** to Locoomo riders (before
  pickup). **Bags can't go to Locoomo riders yet:** sealed bags wait and are retried every
  15 minutes; tell the hubs to hold them. When Sendii recovers they go automatically.
- **Status looks stale:** **Reconcile** pulls the courier's current state.

### 4.6 Parcels missing from a bag

The email lists the bag and the parcels not scanned in at the destination 24 h after
arrival. Call the destination Node: often it's on the shelf but not scanned (ask them to
scan it in). If it's really missing: check the hub (was it bagged? All orders › parcel ›
deliveries), then record it lost (§4.4).

### 4.7 Abandoned returns

Merchant returns not collected: free for 10 working days, then ₦100/day, disposed of
30 days after fees start (merchant emailed when fees start and 7 days before). On
disposal ops get the list: arrange removal from each Node under the merchant terms. A
merchant asking for more time before disposal: collect it now (return batch), or refund
fees after collection (§4.2). Disposal can't be undone in the system.

### 4.8 Hubs and manifests

- Make a Node a hub: Node edit › "Hub". Assign a merchant's hub: Merchant › Settings ›
  Hub.
- A truck without its manifest: hub staff scan parcels anyway (our label, merchant
  reference or merchant barcode); they're received normally.
- Unidentified parcel (`PARCEL_NOT_FOUND` at the hub): set it aside; ops search All orders
  by the merchant's reference or contact the merchant.

---

## 5. Data protection (NDPA)

### 5.1 What we keep, and for how long (enforced by the worker every 6 hours)

| Data | Kept | Then |
|---|---|---|
| Receiver name, phone, email, collector name on a parcel | 180 days after the parcel is finished | Redacted (order, its events, the merchant shipment and timeline) |
| Counter photos (proof of delivery, refusals) | 180 days after the parcel is finished | Deleted from storage |
| KYC documents and director IDs | 90 days after a rejection; 5 years after an account closes | Deleted (files and records) |
| Sandbox (test) shipments, manifests, return batches | 90 days | Deleted (test wallet lines stay so balances add up) |
| Merchant API request logs | 30 days | Deleted |
| Merchant webhook events and deliveries | 30 days | Deleted |
| Audit log | Kept | Never holds personal data or secrets (redacted on write) |

*The plan proposes 14 days for API logs; 30 days is what runs today. Confirm with the DPO.*

### 5.2 A person asks for their data, or to be erased

1. **Verify identity** (they must prove they control the phone or email: e.g. reply from
   that email, or a code sent to that phone). Log the request with a reference.
2. A `super` admin runs Admin › Privacy:
   - **Export:** `POST /admin/privacy/subject-export` `{ phone }` or `{ email }` → every
     parcel and merchant shipment with their details. Send it to them securely.
   - **Erase:** `POST /admin/privacy/subject-erase` `{ phone | email, reason: "<request
     ref>" }` → their details are redacted from every **finished** parcel (photos deleted).
     Parcels **still on their way** are listed in `skippedInFlight`: tell them those are
     erased once delivered or returned, and run erase again then.
3. Merchants hold their own copy of buyer data (they're the controller for it): point the
   person to the merchant for that.
4. Reply within the period the NDPA and our DPA require (**confirm the deadline with the
   DPO**).

Both actions are audited (who, when, how many records), without the personal data.

### 5.3 Personal-data breach

1. **Contain:** revoke what leaked (sessions, API keys, secrets: §6), take the affected
   feature offline (kill switches §4.1) if needed.
2. **Assess:** what data, whose, how many, since when. Engineering preserves logs.
3. **Notify NDPC within 72 hours** of becoming aware, if the breach is likely to put
   people at risk (DPO decides and files). Include: nature, categories and numbers
   affected, likely consequences, measures taken, DPO contact.
4. **Tell affected people** without undue delay when the risk to them is high; tell
   affected **merchants** (we process their buyers' data for them) at the same time.
5. **Record** the breach (facts, effects, actions) even if not notifiable.
6. Post-mortem within 5 working days.

Whether NDPC "major importance" registration applies to Locoomo is an open legal
question (plan §15, F7).

---

## 6. Secrets and switches (engineering)

| Setting | What rotating it does |
|---|---|
| `JWT_ACCESS_SECRET` | Signs sessions and **export download links**: rotating signs everyone out and voids open export links (15-minute life anyway) |
| `TRACKING_LINK_SECRET` | Voids every public tracking link already sent (buyers can still track with phone last 4) |
| `DATA_ENCRYPTION_KEY` | **Don't rotate** without a re-encryption migration: 2FA seeds, KYC ID numbers, bank accounts, merchant webhook signing secrets and return-batch codes are sealed with it |
| `PAYSTACK_*`, `SENDII_*`, `SMS_API_KEY`, Cloudinary | Rotate at the provider, then update the service variable; redeploy |
| Merchant API keys | Merchants roll their own; ops can see metadata in Merchant 360. A leaked key: ask the merchant to revoke, or suspend the merchant |

| Switch | Effect |
|---|---|
| `MERCHANT_PLATFORM_ENABLED=false` | All `/merchant` routes `503` |
| `MERCHANT_LIVE_SHIPMENTS_ENABLED=false` | New live shipments refused (reads and test mode keep working) |
| Merchant `creationPaused` | That merchant's new live shipments refused |
| `RETURN_STORAGE_FEE_KOBO=0` | Stops storage fees (disposal still happens) |

---

## 7. Deploys

1. Merge to `dev` with tests green (unit, e2e, lint, boundaries).
2. PR `dev → staging`; Railway deploys staging. Check the logs for "Applied N
   migration(s)" and "Nest application successfully started", then `/health`.
3. Production: PR `staging → main`, same checks on `api.locoomo.com`.
4. Migrations run on start; enum values are added in their own migrations. If a deploy
   fails after a migration, roll forward with a fix (down migrations are for local use).
5. Load check for hubs: `npm run test:load` against a test database (one hub, 2,000
   parcels: ~15 scans/s on a dev machine).
