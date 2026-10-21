# Adding a courier

How to plug a new delivery partner into the logistics layer
(`src/modules/logistics`). The order flow never changes for a new courier — everything
courier-specific lives in one adapter.

## How it fits together

```
drop-off confirmed (handoffs)
  └─ DeliveryDispatchService.dispatch(order)
       ├─ LogisticsRouterService picks a provider   ← logistics_providers rows + registered adapters
       ├─ inserts a delivery_legs row (status: requested)
       └─ remote provider → outbox job 'logistics.submit' → adapter.createDelivery()
                                   non-retryable error → leg cancelled, order re-routed (fallback)

courier progress (webhook / polling / in-house handover)
  └─ DeliveryEventsService.applyProviderEvent(...)   ← normalised DeliveryEventType
       ├─ moves the leg (illegal / duplicate / stale-sequence events are ignored)
       └─ DeliveryEventBus → DeliveryProgressListener (handoffs) moves the order
```

- **Delivery leg** — one courier's attempt at moving a parcel between two Nodes. History is
  kept; at most one leg per order is active.
- **Provider** — an adapter implementing `LogisticsProvider`
  (`domain/ports/logistics-provider.port.ts`). In-house riders are one too
  (`infrastructure/in-house-riders.provider.ts`), which is why fallback to them is just
  routing.
- **Routing** — `domain/routing.ts`: the first provider by `priority` that is enabled,
  registered, under its `maxAttempts` for this order, inside its distance limits, and (if
  `pilotNodeIds` is set) piloted at the origin Node. In-house is priority 1000 — the
  fallback.

## Steps

1. **Adapter** — `src/modules/logistics/infrastructure/<name>.provider.ts`, implementing
   `LogisticsProvider` and registering itself in `onModuleInit`
   (`LogisticsProviderRegistry.register(this)`), like `InHouseRidersProvider`.
   - `key` — stable id, also the `logistics_providers.key`.
   - `capabilities` — be accurate: `handover: 'provider_code'` if staff read the courier
     *their* code; `remoteSubmission: true` for an HTTP API (submission then runs through
     the outbox); `updates: 'webhook'` or `'polling'`.
   - `createDelivery` — pass `request.legId` as the provider's idempotency key / external
     reference, so an outbox retry can't create a second job. Return the provider's id as
     `externalId`.
   - Map every provider status onto `DeliveryLegStatus` / `DeliveryEventType`; convert money
     to integer kobo; never return raw provider payloads.
   - HTTP via `fetchWithPolicy` (`src/common/http`) with a timeout; retries only on
     idempotent calls.
   - Throw `LogisticsProviderError` with `retryable: false` for "this provider can't take
     it" (rejected request, no balance, service paused) — the order falls back to the next
     provider. Anything retryable: `retryable: true`, and the outbox retries with backoff.
   - Send only Node (counter) details and the tracking code — never the receiver's personal
     data.
2. **Config** — secrets in env (`<NAME>_*` in `src/config/env.validation.ts`,
   `.env.example`, CI), optional with a `.refine` if the courier can be switched off.
3. **Routing row** — a migration inserting into `logistics_providers` with `enabled:
   false`, then turn it on per environment (start with `pilotNodeIds`). Only rows whose
   adapter is registered are ever routed to.
4. **Progress** — webhook and/or polling that ends in
   `DeliveryEventsService.applyProviderEvent(key, externalId, event, snapshot, manager)`
   inside a transaction. Pass the provider's monotonic `sequence` when it has one; stale
   updates are then dropped.
5. **Tests**
   - Adapter unit spec mocking `global.fetch` (see `notifications/infrastructure/resend-api-email-sender.spec.ts`).
   - The external-courier e2e block in `test/handoffs/handoffs.e2e-spec.ts` shows how a
     provider is exercised end-to-end with a fake; copy it for the new courier's flow.

## Rules worth keeping

- The order state machine only reacts to `DeliveryEventBus` notices — don't call
  `OrdersService` from an adapter.
- Don't store handover codes from a provider; fetch them live when a Node screen needs
  them.
- `providerKey` and leg `status` are plain varchar columns: a new courier or state needs no
  enum migration.
