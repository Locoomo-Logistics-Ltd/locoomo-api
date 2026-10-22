# Sendii — setup and operations

Runbook for the Sendii courier integration (`src/modules/logistics/infrastructure/sendii`).
For how couriers plug in generally, see [ADDING_A_COURIER.md](ADDING_A_COURIER.md).

## What it does

Once switched on, an order dropped off at a Pickup Station is handed to Sendii
automatically: Locoomo quotes and books a Sendii rider from the origin station's counter to
the destination station's counter. Sendii's rider collects with a **pickup code** the origin
staff read out, and hands over with a **delivery code** the destination staff read out
(`GET /handoffs/orders/:id/courier-handover`). Progress arrives by webhook and is
double-checked by polling. If Sendii can't take an order — out of range, wallet too low,
service paused, no rider found within 20 minutes, rejected twice — it goes to the Locoomo
rider pool instead.

Only Node counter details and the tracking code are sent to Sendii — never the receiver's
name, phone or the parcel description.

## Environments

The API key decides the environment: `sk_test_…` is the sandbox, `sk_live_…` is live (live
keys only work once Sendii has approved KYC). Everything — deliveries, wallet, webhook
endpoints — is separate per environment.

## Switching it on

1. **Env** — set `SENDII_API_KEY`. Without it the adapter isn't loaded at all.
2. **Webhook** — the API must be reachable on public HTTPS. Then:
   ```bash
   npm run sendii:webhook -- register https://api.example.com
   ```
   This registers `https://api.example.com/api/v1/logistics/webhooks/sendii` and prints
   `SENDII_WEBHOOK_SECRET=whsec_…` **once** — set it in the environment and restart.
   `npm run sendii:webhook -- list | test <id> | delete <id>` manage it afterwards.
   Local development: expose the API with a tunnel (`cloudflared tunnel --url
   http://localhost:3000` or ngrok) and register the tunnel URL with a sandbox key.
   Without a webhook secret, progress still arrives — just later, through polling every
   few minutes.
3. **Wallet** — live: fund it by bank transfer to the dedicated account shown in Sendii's
   portal. Sandbox: `POST /test/wallet/topup`. Before booking, Locoomo checks the available
   balance covers the fee plus 60% (worst-case surcharges) and the same headroom for
   deliveries already in progress; otherwise the order goes to Locoomo riders and an error
   is logged (`Sendii wallet too low`).
4. **Routing** — the `sendii` courier ships **disabled**. Turn it on from the admin API
   (see API.md › Admin: couriers and deliveries), starting with a pilot:
   ```
   PATCH /api/v1/admin/logistics/providers/sendii
   { "enabled": true, "pilotNodeIds": ["<origin-node-uuid>"] }   # pilot stations only
   { "pilotNodeIds": null }                                       # everywhere — Sendii becomes the default
   { "enabled": false }                                           # off again (in-flight deliveries finish)
   ```
   `GET /api/v1/admin/logistics/providers` shows `registered: true` once the adapter is
   running (needs `SENDII_API_KEY`). Other settings on the same endpoint: `maxAttempts` (2),
   `assignTimeoutMinutes` (20), `minDistanceKm`/`maxDistanceKm` (0.1 / 80 — Sendii's
   limits), `maxCostShare` (0.75), `lowBalanceAlertNaira` (₦50,000).

Before enabling a station, check it has a `contactPhone` (Sendii requires one for the
destination) and correct coordinates.

## Vehicles and cost cap

Each order carries the vehicle its parcel needs (motorbike or car — see API.md › Pricing);
Sendii is only offered vehicles it runs, and books that vehicle. The `sendii` row's
`maxCostShare` (0.75) caps Sendii's quote at 75% of the order's delivery fee: a dearer
quote isn't booked and the order goes to the next courier (`failureReason` starts
`QUOTE_ABOVE_LIMIT`). Road distances from Sendii's quotes are remembered per Node pair and
make later prices more accurate.

## Day to day

| Situation | What happens |
|---|---|
| No rider within 20 min | The reconciler cancels it at Sendii and re-books (2nd attempt), then falls back to Locoomo riders |
| Sendii cancels (`no_rider_found`, `dispatch_failed`, …) | Order goes back to "waiting for a rider", then the same retry/fallback |
| Rider drops the job before pickup | Order goes back to waiting; Sendii looks for another rider |
| Failed drop-off attempt | Sendii retries (up to 2 redeliveries); surcharge recorded on the delivery leg |
| Delivery fails for good | Sendii brings it back to the origin station (`return_in_transit`; sender and receiver emailed). Origin staff read the returning rider the code, then shelve it (`return-intake`) — the sender gets a collection code and collects it (`return-collect`). Sendii charges the fee plus a 20% return surcharge; no fee is charged to the sender |
| Webhook lost or out of order | The reconciler polls quiet deliveries every few minutes; Sendii's current state is applied, stale updates ignored |
| Sendii API down | Bookings retry through the outbox; the station screen shows "couldn't load the code, try again" |

Where to look: the admin API — `GET /admin/logistics/deliveries?provider=sendii&stuck=true`
for anything stuck, `/providers/sendii/wallet` for the balance, `/economics?provider=sendii`
for cost vs allocation per order, and `POST /deliveries/:id/fallback` / `/reconcile` /
`/retry` to intervene. The equivalent SQL, if needed:

```sql
-- Deliveries in progress with Sendii
SELECT "orderId", status, "providerStatus", "externalId", "courierName", "quotedKobo",
       "surchargeKobo", "updatedAt"
  FROM delivery_legs WHERE "providerKey" = 'sendii' AND "endedAt" IS NULL;

-- Why orders fell back
SELECT "orderId", "failureReason", "createdAt" FROM delivery_legs
 WHERE "providerKey" = 'sendii' AND status = 'cancelled' ORDER BY "createdAt" DESC;

-- Webhooks not processed yet
SELECT * FROM logistics_inbound_events WHERE "processedAt" IS NULL;
```

## Settlement during the pilot

For orders Sendii delivered, the rider's 60% is recorded as a non-payable
`courier_allocation` earnings row (see API.md › Earnings). Sendii's actual charge is on the
delivery leg (`actualKobo` + `surchargeKobo`), so allocation minus cost is the per-order
surplus or shortfall until the commercial rule is agreed.

## Not supported by Sendii

Cash on delivery, scheduled pickups, vans (car is the largest vehicle), photo proof of
delivery, live rider GPS (only Sendii's tracking page). Trips must be 100 m – 80 km within
Nigeria.
