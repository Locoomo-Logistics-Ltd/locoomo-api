# API Guide for Frontend Integration

What the frontend needs to consume this API: base URL, auth flow, response shape, error
codes, and endpoint-by-endpoint request/response contracts. Kept current as endpoints
ship — if something you need isn't here, it isn't built yet.

Upcoming courier integration, Node-app scan flow and public tracking page: see the draft
contract in [LOGISTICS_API.md](LOGISTICS_API.md) — not live yet, sections move here as they ship.

## Base URL and versioning

```
{API_ORIGIN}/api/v1/...
```

`/health` is the one exception — unprefixed, unversioned, infra probe only, not for
frontend use.

## CORS and cookies — read this before writing any auth code

Sessions are httpOnly cookies, not bearer tokens — there is no token for frontend code
to read or store. This has real implications for how you call the API:

- **Every request that should carry the session must set `credentials: 'include'`**
  (`fetch`) or `withCredentials: true` (axios). Without it, the browser won't send the
  session cookies even if they exist.

- **The frontend origin must be on the allow-list** the API's `CORS_ORIGIN` env var
  defines. If you're getting CORS errors, that's almost certainly it — ask backend to
  add your dev origin (e.g. `http://localhost:5173`).

- **The frontend must be same-site with the API** — same registrable domain, e.g.
  `app.locoomo.com` calling `api.locoomo.com`. 

- You cannot read `access_token` or `refresh_token` from JavaScript (`document.cookie`)
  — they're httpOnly by design (XSS protection). Don't build UI that assumes you can
  inspect or manually attach them.

## Authenticated requests

Every route except `/health` and the `/api/v1/auth/*` endpoints below requires a
valid `access_token` cookie — this is enforced globally, not per-route, so a new
endpoint is protected by default the moment it ships. The contract:

- Missing or invalid (bad signature, malformed, wrong secret) → `401 UNAUTHENTICATED`.
- Expired access token → also `401 UNAUTHENTICATED` (identical to missing/invalid —
  same enumeration-avoidance reasoning as the login/refresh errors). This is your signal
  to call `/api/v1/auth/refresh` and retry the original request.
- Valid session, but the route requires a role you don't have → `403 FORBIDDEN`. The
  response doesn't say which role was required.

`POST /api/v1/users/invite` (below) is the first route that's both authenticated *and*
role-gated (Admin only) — the same two-layer check applies: no session → 401, valid
session but not an Admin → 403.

## Response envelope

Every response (except `/health`) is wrapped the same way. Always unwrap `data`, never
assume a raw resource body.

Success:

```json
{
  "success": true,
  "data": { "...": "endpoint-specific" },
  "meta": {
    "correlationId": "b1f2c3d4-...",
    "timestamp": "2026-07-22T09:14:00.000Z"
  }
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "correlationId": "b1f2c3d4-...",
    "details": [
      { "field": "email", "constraint": "isEmail", "message": "email must be an email" }
    ]
  }
}
```

`details` is only present on validation errors (400). Branch UI logic on `error.code`,
not `error.message` — the message is human-readable copy and can be reworded without
warning; the code is the stable contract.

Every response also carries an `X-Correlation-Id` response header (same value as
`meta.correlationId` / `error.correlationId`). Include it in bug reports — it's what
backend greps logs for.

## Error codes reference

| HTTP | code | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Request body failed DTO validation — see `error.details` for per-field reasons |
| 400 | `INVALID_VERIFICATION_DOCUMENT` | `POST /riders/onboarding` referenced a `cloudinaryPublicId` that doesn't correspond to an actual completed upload — re-request an upload signature and try again |
| 401 | `INVALID_CREDENTIALS` | Login failed — wrong password, unknown email, or account not yet activated. Deliberately identical for all three so a login attempt can't be used to enumerate registered emails; don't try to distinguish these cases in the UI |
| 401 | `INVALID_REFRESH_TOKEN` | Refresh failed — missing, unrecognized, expired, or already-used cookie. Treat as a hard sign-out, don't retry |
| 401 | `INVALID_RESET_TOKEN` | Password reset confirm failed — missing, unrecognized, expired, or already-used token. Deliberately identical for all cases; send the user back to "forgot password" |
| 401 | `INVALID_VERIFICATION_TOKEN` | Email verification failed — missing, unrecognized, expired, or already-used token. Same enumeration-avoidance reasoning; there's no harm shown to the user beyond "this link didn't work" |
| 401 | `INVALID_INVITE_TOKEN` | Invite confirm failed — missing, unrecognized, expired, or already-used token. Same reasoning; send the invitee back to whoever provisioned their account |
| 401 | `INVALID_GOOGLE_TOKEN` | `POST /auth/google` — the Google ID token didn't verify (bad signature, wrong audience, expired), Google reported the email as unverified, or the token verified but had no usable name to register with. Retry the Google flow from scratch, it's not something the client can fix by resubmitting the same token |
| 400 | `CONSENT_REQUIRED` | `POST /auth/google` — a brand-new account attempt without `consentAccepted: true`. Never returned when the call turns out to be a login (existing `googleId`) |
| 400 | `PROFILE_INCOMPLETE` | `POST /riders/onboarding` or `POST /node-operators/onboarding` — the account has no `phone` set yet. Call `PATCH /users/me` first |
| 401 | `UNAUTHENTICATED` | No valid `access_token` cookie on a protected route — missing, invalid, or expired. Refresh and retry |
| 403 | `ACCOUNT_SUSPENDED` | Password was correct but the account is suspended |
| 403 | `FORBIDDEN` | Valid session, but your role can't access this route |
| 404 | `NOT_FOUND` | Route or resource doesn't exist. Also returned for a Node that exists but isn't `active` when you're not an Admin — visibility is hidden as "not found," not `403`, so a non-Admin can't distinguish "doesn't exist" from "pending approval." `POST /payments/intents` also returns this for a Node that's `active` but `isPubliclyVisible: false` — same hiding treatment, whether you're the Consumer submitting the request or just probing an id |
| 401 | `INVALID_WEBHOOK_SIGNATURE` | `POST /payments/webhooks/paystack` signature didn't verify — not a frontend-facing error, listed for completeness |
| 409 | `EMAIL_ALREADY_REGISTERED` | Registration (password or Google), or an admin invite, attempted with an email already on file. For `POST /auth/google` specifically: the verified email belongs to a different, non-Google account — there is no auto-link, log in with the password instead |
| 409 | `NODE_OPERATOR_ALREADY_ONBOARDED` | `POST /node-operators/onboarding` called by an account that's already completed onboarding — use `POST /node-operators/nodes` for another Node |
| 400 | `NODE_OPERATOR_NOT_ONBOARDED` | `POST /node-operators/nodes` called by an account that hasn't completed `POST /node-operators/onboarding` yet |
| 409 | `RIDER_ALREADY_ONBOARDED` | `POST /riders/onboarding` called by an account that already has a rider profile |
| 400 | `CANNOT_REMOVE_OWNER_MEMBERSHIP` | `DELETE /node-operators/nodes/:nodeId/staff/:userId` — `:userId` refers to that Node's owner membership, not a staff one. Not reachable through the normal flow (`GET .../staff` only ever lists staff), rejected directly if attempted anyway |
| 409 | `NODE_CAPACITY_UNAVAILABLE` | `POST /payments/intents` — the origin Node filled up between you seeing it in `/nodes/nearby` and this request landing. Show the consumer a "that drop-off point just filled up, try another" message, not a generic error |
| 403 | `RIDER_NOT_ACTIVE` | `POST /handoffs/orders/:id/accept` — your rider role is valid but your `RiderProfile` isn't `active` yet (still `pending` Admin review, or `suspended`) |
| 403 | `NODE_NOT_ACTIVE` | `POST /node-operators/nodes/:nodeId/staff/invite`, `PATCH /node-operators/nodes/:nodeId/visibility`, or `POST /node-operators/nodes/:nodeId/dispatch` — the target Node hasn't been Admin-approved yet |
| 409 | `RIDER_CAPACITY_UNAVAILABLE` | `POST /handoffs/orders/:id/accept` — you already have the maximum number of concurrent active deliveries (3). Finish or hand off one before accepting another |
| 409 | `ILLEGAL_ORDER_TRANSITION` | A handoff scan/confirm endpoint was called while the order isn't in the state that step expects — either stale client state or someone else already advanced it. Re-fetch the order and refresh the UI rather than retrying blindly |
| 401 | `INVALID_HANDOFF_CODE` | `POST /handoffs/orders/:id/confirm-handoff` and `POST /handoffs/orders/:id/collect` — the code was missing, expired, already used, locked out after too many wrong guesses, or just wrong. Deliberately identical for all of these, same enumeration-avoidance reasoning as other invalid-token errors; request/resend a fresh code either way |
| 409 | `ORDER_NOT_READY_FOR_COLLECTION` | `POST /handoffs/orders/:id/collection-code/resend` — called before `POST /handoffs/orders/:id/intake` has run (or after the order's already `completed`). There's no collection code to resend yet |
| 400 | `NODE_LOCATION_MISMATCH` | `POST /nodes`, `PATCH /nodes/:id`, `POST /node-operators/onboarding`, `POST /node-operators/nodes` — the map pin is clearly not where the address is. Show the message (it says where the address actually is) and let the user move the pin or fix the address |
| 400 | `INVALID_REVENUE_SPLIT` | `POST /admin/revenue-split` — `riderPercent`/`nodePercent`/`platformPercent` didn't sum to 100 |
| 400 | `BANK_ACCOUNT_VERIFICATION_FAILED` | `PATCH /riders/me/payout-account` or `PATCH /node-operators/nodes/:nodeId/payout-account` — Paystack couldn't resolve that `accountNumber` at that `bankCode`. Nothing is saved; a previously-verified payout account on file, if any, is untouched |
| 429 | `RATE_LIMITED` | Too many requests to this route from your IP. `/auth/register` and `/auth/login` allow 5/min; `/payments/intents` allows 5/min; `/track/:trackingCode` allows 10/min; `/handoffs/orders/:id/courier-handover` allows 20/min; `/delivery-quotes` allows 30/min; everything else defaults to 100/min |
| 500 | `INTERNAL_ERROR` | Unexpected server failure — message is always the generic "Something went wrong," never internal detail. Report the `correlationId` to backend |
| 409 | `COURIER_HANDOVER_NOT_AVAILABLE` | `GET /handoffs/orders/:id/courier-handover` — nothing to hand an external courier at your Node right now. Refresh the order and follow `nextAction` |
| 422 | `NO_DELIVERY_OPTION` | `POST /delivery-quotes`, `POST /payments/intents`, `POST /node-operators/nodes/:nodeId/dispatch` — no vehicle we run can carry this parcel, or no courier serves that vehicle between these Nodes. Ask for different parcel details or Nodes; retrying unchanged won't help |
| 409 | `REVENUE_SPLIT_NOT_PAYABLE` | `PATCH /admin/revenue-split/entries/:id/mark-paid` on a `courier_allocation` row — recorded for reporting only, never paid |
| 409 | `ILLEGAL_DELIVERY_ACTION` | `/admin/logistics/...` — the action doesn't apply to the delivery or courier in its current state (e.g. fallback after pickup, switching off in-house riders); the message says why |
| 502 | `LOGISTICS_PROVIDER_ERROR` | A courier's API failed or timed out while you waited (e.g. loading a handover code). Safe to retry |
| 502 | `PAYMENT_PROVIDER_ERROR` | Paystack's API failed, timed out (15 s) or was unreachable — placing an order, listing banks, or resolving a payout account number. Safe to retry |
| 503 | `PRICING_NOT_CONFIGURED` | No Admin-configured pricing rule exists yet — an ops/config gap, not something the consumer caused; surface as "orders temporarily unavailable" |
| 503 | `REVENUE_SPLIT_NOT_CONFIGURED` | `POST /handoffs/orders/:id/collect` — no Admin-configured revenue-split rule exists yet, so the order can't complete without its earnings going untracked. Same ops/config gap as `PRICING_NOT_CONFIGURED`, not something the operator or receiver caused |

## Endpoints

### `POST /api/v1/auth/register`

Self-registration for **Consumer** (default), **NodeOperator**, or **Rider**
(`role: "node_operator"` / `"rider"` in the request body). Admin can't self-register —
use `POST /users/invite` for that. This is the same endpoint for all three allowed
roles, not a separate one per role, differing only in `role` and the resulting `status`.

Consumer is immediately `active` — no separate activation step, and verifying the email
is **not** required to log in. NodeOperator/Rider land in `pending_review` instead —
they *can* log in right away (a password is set immediately, same as Consumer), but
can't operate until they complete their module's onboarding step
(`POST /node-operators/onboarding` or `POST /riders/onboarding`, below) and an Admin
approves it. Either way, a verification email is sent asynchronously (same ~10s outbox
delay as password reset) with a link of the form `{FRONTEND_URL}/verify-email?token=...`;
`emailVerifiedAt` stays `null` until that link is used, purely informational for now.

**`phone` is not collected here.** Every new account — password or Google — starts with
`phone: null` and completes it afterward via `PATCH /users/me` (below). Consumer's missing
phone is non-blocking (delivery contact comes from the order's `receiverPhone`, not
`User.phone`); NodeOperator/Rider **must** set it before `POST /node-operators/onboarding`
/ `POST /riders/onboarding` will succeed — those return `400 PROFILE_INCOMPLETE` until it's
set. Show a "complete your profile" prompt on the dashboard whenever `GET /users/me`'s
`phone` is `null`.

Request:

```json
{
  "firstName": "Ada",
  "lastName": "Lovelace",
  "email": "ada@example.com",
  "password": "Correct-Horse-Battery-1",
  "passwordConfirmation": "Correct-Horse-Battery-1",
  "consentAccepted": true,
  "role": "node_operator"
}
```

| Field | Rules |
|---|---|
| `firstName`, `lastName` | 1–100 chars |
| `email` | valid email, max 255 chars, case-insensitive (stored lowercased) |
| `password` | 12–128 chars. No composition rules beyond length (current OWASP guidance) — don't build a strength meter checking for uppercase/symbols/etc., it'd reject valid passwords this API accepts |
| `passwordConfirmation` | must exactly match `password` |
| `consentAccepted` | must be `true` — ToS/Privacy Policy acceptance (NDPA), there is no "accept later" |
| `role` | optional, defaults to `consumer`. Only `consumer`, `node_operator`, or `rider` accepted — anything else is `400 VALIDATION_FAILED` |

Response `201`, `data`:

```json
{
  "id": "uuid",
  "email": "ada@example.com",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "phone": null,
  "role": "node_operator",
  "status": "pending_review",
  "emailVerifiedAt": null,
  "createdAt": "2026-07-22T09:14:00.000Z"
}
```

Registration does **not** log the user in — no session cookies are set. Send the user to
login next.

Errors: `400 VALIDATION_FAILED`, `409 EMAIL_ALREADY_REGISTERED`, `429 RATE_LIMITED`
(5 requests/min per IP — stricter than the app-wide default).

### `POST /api/v1/auth/google`

Sign up or log in with Google — one endpoint, both outcomes, distinguished server-side by
whether the verified Google account is already linked to a user. This is a **signup path
for new users, not an alternate login for an existing password-based account**: if the
verified email already belongs to a different (password, invited, ...) account, this is
rejected outright rather than logged into or linked — see `EMAIL_ALREADY_REGISTERED` above.

The frontend obtains a signed ID token via Google Identity Services client-side and sends
just that token here — the backend independently verifies it against Google's own keys, it
never trusts a client-asserted email/name. `role`/`consentAccepted` only matter if this
turns out to create a new account; both are ignored on a plain login (existing `googleId`).

Request:

```json
{
  "idToken": "the-signed-id-token-from-google-identity-services",
  "role": "rider",
  "consentAccepted": true
}
```

| Field | Rules |
|---|---|
| `idToken` | required, the raw Google ID token |
| `role` | optional, defaults to `consumer`. Only `consumer`, `node_operator`, or `rider` — same list as `POST /auth/register`. Ignored when the call turns out to be a login |
| `consentAccepted` | required to be `true` **only when this creates a new account** — omit or send `false` on a call you expect to be a login |

Response `200`, `data`: same `UserResponseDto` shape as login/register — `phone: null` on a
freshly created account, same as password registration. **Unlike `POST /auth/register`,
this logs the user in immediately** — session cookies are set on the response, since a
Google-created account has no password to log in with afterward. Same cookie table as
`POST /auth/login` below.

Errors: `400 VALIDATION_FAILED`, `400 CONSENT_REQUIRED`, `401 INVALID_GOOGLE_TOKEN`,
`403 ACCOUNT_SUSPENDED`, `409 EMAIL_ALREADY_REGISTERED`, `429 RATE_LIMITED` (same 5/min
bracket as register/login).

### `POST /api/v1/auth/login`

Request:

```json
{ "email": "ada@example.com", "password": "Correct-Horse-Battery-1" }
```

Response `200`, `data`: same `UserResponseDto` shape as register's response. The
session is delivered via `Set-Cookie`, not the body — see the cookie table below.

Errors: `400 VALIDATION_FAILED`, `401 INVALID_CREDENTIALS`, `403 ACCOUNT_SUSPENDED`,
`429 RATE_LIMITED`.

After 5 wrong passwords in a row, the account itself locks for 15 minutes — further
attempts return `401 INVALID_CREDENTIALS` even with the correct password, identical to
every other invalid-credentials case (no way to tell "locked" from "wrong password" from
the response). This is separate from and in addition to the per-IP rate limit above: the
IP limit slows down raw request volume from one source, the lockout catches a slow or
distributed attack against one specific account regardless of source IP. A successful
login resets the counter.

| Cookie | Lifetime | Path | Notes |
|---|---|---|---|
| `access_token` | 15 min | `/` | Sent automatically on every request to the API's origin |
| `refresh_token` | 30 days | `/api/v1/auth` | Sent only to endpoints under `/api/v1/auth` (refresh, logout) — never to ordinary application routes |

Both `httpOnly`, `Secure` in production, `SameSite=Strict`.

### `POST /api/v1/auth/refresh`

No request body — the refresh token is read from the `refresh_token` cookie, which the
browser sends automatically (that's why it's scoped to the `/api/v1/auth` subtree). Call
this when an authenticated request comes back `401` because the access token expired,
then retry the original request.

Response `200`, `data`: same `UserResponseDto` shape as login's. Both cookies are
reissued — the old `refresh_token` is invalidated the instant a new one is issued
(rotation on every call, not just on expiry).

Errors: `401 INVALID_REFRESH_TOKEN`, `403 ACCOUNT_SUSPENDED`. On **any** error response
from this endpoint, both session cookies are cleared server-side — treat that as a hard
sign-out and route the user to login rather than retrying.

`401 INVALID_REFRESH_TOKEN` is deliberately generic — it covers "no cookie sent,"
"expired," and "already used" identically. One specific case worth knowing about: if two
requests both try to refresh the same token concurrently (e.g. two tabs, or a retry
firing before the first call returned), the second one back will get this error even
though nothing malicious happened — refresh tokens are single-use. Don't fire refresh
speculatively from multiple places; centralize it (e.g. one in-flight refresh promise
shared by all callers) once you're building the interceptor that triggers this on 401.

### `POST /api/v1/auth/logout`

No request body. Revokes the current session's refresh token (the one in the cookie)
and clears both cookies — call this on every "sign out" action.

Response `200`, `data: null`.

No error responses — this endpoint never fails. Calling it with no session, an already
expired session, or a garbage cookie all just return `200` (the desired end state —
"no active session" — is already true, so there's nothing to reject). Don't build error
handling around this call.

Only revokes the session tied to the cookie you're holding — if the user is logged in
on another device/tab, that session is untouched. There's no "sign out everywhere"
endpoint yet.

### `POST /api/v1/auth/password-reset/request`

Request:

```json
{ "email": "ada@example.com" }
```

Response `200`, `data: null` — **always**, regardless of whether the email is registered,
unregistered, or belongs to an account that hasn't set a password yet (Admin-provisioned,
still `invited`). Never branch UI logic on this response to reveal whether an email
exists — that's deliberate, same enumeration-avoidance reasoning as login. Show a generic
"if that email is registered, we've sent a reset link" message regardless.

If the email matches an active account, an email is sent (asynchronously — the outbox
poller runs on a ~10s interval, so don't expect instant delivery) with a link of the form
`{FRONTEND_URL}/reset-password?token=...`. The frontend route at that path reads `token`
from the query string and submits it to the confirm endpoint below — the token itself is
never meant to be typed or shown in the UI.

The link expires in 30 minutes. Requesting a new one immediately invalidates any
previous unused link for that account — only the most recently requested one ever works.

Errors: `400 VALIDATION_FAILED`, `429 RATE_LIMITED` (5 requests/min per IP, same as
register/login).

### `POST /api/v1/auth/password-reset/confirm`

Request:

```json
{
  "token": "the-token-from-the-emailed-link",
  "password": "New-Correct-Horse-2",
  "passwordConfirmation": "New-Correct-Horse-2"
}
```

Same password rules as registration (12–128 chars, no composition requirements).

Response `200`, `data: null`. Every existing session for the account is revoked as part
of this — if the user is logged in elsewhere (or in the same browser), those sessions
stop working immediately and need to log in again with the new password. A "your password
was changed" notice is also emailed to the account, independent of who initiated the
reset.

Errors: `400 VALIDATION_FAILED`, `401 INVALID_RESET_TOKEN` (bad, expired, already-used, or
superseded token — send the user back to request a new link), `429 RATE_LIMITED`.

### `POST /api/v1/auth/verify-email`

Request:

```json
{ "token": "the-token-from-the-emailed-link" }
```

Response `200`, `data: null`. Sets `emailVerifiedAt` on the account. This is informational
only right now — nothing in the API is gated on it, and there's no "resend verification
email" endpoint yet (unlike password reset, the link is only ever sent once, at
registration).

Errors: `400 VALIDATION_FAILED`, `401 INVALID_VERIFICATION_TOKEN` (bad, expired, or
already-used token), `429 RATE_LIMITED`.

### `POST /api/v1/users/invite`

**Requires an authenticated Admin session** — this is not a public `/auth/*` route.
NodeOperator, Rider, and Admin accounts are never self-registered; an existing Admin
provisions them here.

Request:

```json
{
  "firstName": "Ada",
  "lastName": "Lovelace",
  "email": "ada@example.com",
  "phone": "+2348012345678",
  "role": "node_operator"
}
```

`role` must be one of `node_operator`, `rider`, `admin` — `consumer` is rejected
(`400 VALIDATION_FAILED`), that role is self-registration only.

Response `201`, `data`: same `UserResponseDto` shape as register's response, with
`"status": "invited"`. The account has no password yet and cannot log in until the
invitee completes the confirm step below. An email is sent asynchronously (same ~10s
outbox delay as the other flows) with a link of the form
`{FRONTEND_URL}/accept-invite?token=...`, expiring in 7 days.

Errors: `401 UNAUTHENTICATED` (no session), `403 FORBIDDEN` (session isn't an Admin),
`400 VALIDATION_FAILED`, `409 EMAIL_ALREADY_REGISTERED`.

### `POST /api/v1/auth/invite/confirm`

Public — this is what the invitee's link submits to. Sets their password and activates
the account in one step; nothing to call beforehand.

Request:

```json
{
  "token": "the-token-from-the-emailed-link",
  "password": "New-Correct-Horse-2",
  "passwordConfirmation": "New-Correct-Horse-2",
  "consentAccepted": true
}
```

Same password rules as registration. `consentAccepted` must be `true` — the inviting
Admin can't accept the ToS/Privacy Policy on the invitee's behalf, so it's captured here
instead of at invite-creation time.

Response `200`, `data: null`. Flips `status` to `active`, sets `consentAcceptedAt` and
`emailVerifiedAt` (following the invite link is already proof of email ownership — no
separate verification email for admin-provisioned accounts). The account can log in
immediately after.

Errors: `400 VALIDATION_FAILED`, `401 INVALID_INVITE_TOKEN` (bad, expired, or
already-used token), `429 RATE_LIMITED`.

### `GET /api/v1/users/me`

**Requires an authenticated session — any role.** Returns the caller's own account, same
`UserResponseDto` shape as register/login. The field to actually watch is `phone`: `null`
means the profile-completion nudge (see `POST /auth/register` above) should show.

Response `200`, `data`: same shape as register's response.

Errors: `401 UNAUTHENTICATED`.

### `PATCH /api/v1/users/me`

**Requires an authenticated session — any role.** Sets `phone`, the one thing registration
(password or Google) never collects. Callable again later to change it; there's no
"locked after first set" behavior.

Request:

```json
{ "phone": "+2348012345678" }
```

Response `200`, `data`: the updated `UserResponseDto`.

Errors: `400 VALIDATION_FAILED`, `401 UNAUTHENTICATED`.

### Pagination (list endpoints)

Every list endpoint takes `page` (default `1`) and `limit` (default `20`, max `100`)
query params and returns `data` shaped as:

```json
{
  "items": [ "...": "endpoint-specific" ],
  "page": 1,
  "limit": 20,
  "total": 42
}
```

### `POST /api/v1/nodes`

**Requires an authenticated Admin session.** Creates a Node directly — for
field-recruited, warm-lead, chain-partner, or franchise onboarding, where an Admin
already has all the details in hand. Self-service registration (a NodeOperator signing
up and setting up their own Node) is a separate, not-yet-built flow (`node-operators`
module) — that path creates Nodes in `pending` status; this one goes `active`
immediately, since Admin authorship is itself the trust/verification gate.

Request:

```json
{
  "name": "Lekki Phase 1 Node",
  "address": "12 Admiralty Way",
  "city": "Lagos",
  "state": "Lagos",
  "country": "Nigeria",
  "latitude": 6.4500,
  "longitude": 3.4700,
  "capacity": 100,
  "contactPhone": "0803 123 4567",
  "openingHours": {
    "mon": [{ "open": "08:00", "close": "19:00" }],
    "tue": [{ "open": "08:00", "close": "19:00" }],
    "wed": [{ "open": "08:00", "close": "19:00" }],
    "thu": [{ "open": "08:00", "close": "19:00" }],
    "fri": [{ "open": "08:00", "close": "19:00" }],
    "sat": [{ "open": "09:00", "close": "14:00" }]
  },
  "onboardingType": "field_recruited"
}
```

| Field | Rules |
|---|---|
| `name` | 1–150 chars |
| `address` | 1–255 chars |
| `city`, `state` | 1–100 chars |
| `country` | optional, defaults to `"Nigeria"` |
| `latitude`, `longitude` | valid coordinates |
| `capacity` | integer, 1–100000 — self-reported max parcels this Node can hold; there's no capacity-reservation/locking logic yet, that lands with `orders`/`payments` |
| `contactPhone` | **required** — the counter phone couriers and riders call on arrival. Any common Nigerian format (`0803…`, `234803…`, `+234 803 …`) or an international number with its `+` country code. Always returned normalised to E.164 (`"+2348031234567"`) |
| `openingHours` | **required** — weekly hours, see [Opening hours](#opening-hours) below |
| `operatingHours` | optional free text, max 255 chars. **Deprecated** — superseded by `openingHours`, still accepted and returned until all clients have moved over |
| `forceLocation` | optional boolean, **Admin only** — keep this pin even if it disagrees with where the address geocodes (see [Location check](#location-check)). Recorded as `locationCheck: "admin_override"` |
| `onboardingType` | optional, defaults to `field_recruited`. One of `field_recruited`, `warm_lead`, `chain_partner`, `franchise` — `portal` is rejected here (`400 VALIDATION_FAILED`), it's set only by the future self-registration flow |

Response `201`, `data`: same shape as the Node objects in the list/get responses below,
with `"status": "active"`. Every Node object (here, in `GET /nodes`, `/nodes/nearby`,
`/nodes/:id` and inside `GET /node-operators/me/nodes`) carries `contactPhone` and
`openingHours` — both can be `null` on Nodes created before they existed (the owner fills
them in with `PATCH /node-operators/nodes/:nodeId/contact`).

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin), `400 VALIDATION_FAILED`,
`400 NODE_LOCATION_MISMATCH`.

#### Location check

Every new Node — and any update that changes `address`, `city`, `state`, `country`,
`latitude` or `longitude` — has its map pin checked against the typed address using
Google's geocoder. Couriers navigate by the pin, so a pin dropped in the wrong place means
failed pickups.

- **Pin clearly in the wrong place** → `400 NODE_LOCATION_MISMATCH`, nothing saved. The
  message says how far off it is and where the address actually is, e.g. *"The map pin is
  37.4 km from "Admiralty Way, Lekki Phase 1, Lagos, Nigeria". Move the pin to the Node's
  real location, or correct the address."* "Clearly" means more than 2 km away, or further
  than the address's own fuzziness when Google can only place it at neighbourhood level.
  Use a map-pin picker for `latitude`/`longitude`, never hand-typed numbers.
- **Address can't be checked** (Google doesn't know it, or is unavailable) → the Node is
  saved anyway with `locationCheck: "unverified"`. Creation never blocks on Google.

Node objects carry the outcome as `locationCheck`: `verified`, `unverified`,
`admin_override`, or `null` for Nodes created before the check existed.


An object keyed by day — `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun` — each an
array of `{ "open": "HH:mm", "close": "HH:mm" }` intervals in **Nigerian local time**
(24-hour clock). A day that's missing or `[]` is closed. A day can have up to 4
intervals (e.g. a lunch break), in order and not overlapping. `close` must be later
than `open` on the same day — overnight hours aren't supported, and `24:00` isn't
valid (use `23:59`). A bad value fails with `400 VALIDATION_FAILED` and a `details`
message saying what's wrong (e.g. `"openingHours mon closes before it opens"`).

```json
{
  "mon": [{ "open": "08:00", "close": "13:00" }, { "open": "14:00", "close": "18:00" }],
  "sat": [{ "open": "09:00", "close": "14:00" }],
  "sun": []
}
```

### `GET /api/v1/nodes`

Any authenticated role. Lists Nodes, paginated (see above). Non-Admins always see only
`active` **and** publicly-visible Nodes, regardless of the `status` filter — this is what
keeps pending/suspended/inactive Nodes, and any Node its owner has opted out of public
discovery (`isPubliclyVisible: false` — see `PATCH
/node-operators/nodes/:nodeId/visibility`), out of pickup-station listings. Admins can
filter by `status` and see every Node regardless of visibility.

Query params: `page`, `limit`, `status` (Admin-only filter — `pending`, `active`,
`inactive`, or `suspended`; ignored for non-Admins).

Response `200`, `data.items[]` each:

```json
{
  "id": "uuid",
  "name": "Lekki Phase 1 Node",
  "address": "12 Admiralty Way",
  "city": "Lagos",
  "state": "Lagos",
  "country": "Nigeria",
  "latitude": 6.45,
  "longitude": 3.47,
  "capacity": 100,
  "status": "active",
  "onboardingType": "field_recruited",
  "operatingHours": "Mon-Sat 8am-7pm",
  "isPubliclyVisible": true,
  "createdAt": "2026-07-22T09:14:00.000Z"
}
```

`isPubliclyVisible` (default `true`) is current state only, not a change history — set by
the Node's own owner via `PATCH /node-operators/nodes/:nodeId/visibility`, for a Node
that only dispatches its own parcels through the network and doesn't want public
drop-offs. `false` excludes it here and from `GET /nodes/nearby` below for non-Admin
callers, **and** is enforced server-side against being targeted by a
Consumer-initiated `POST /payments/intents` (not just hidden from these two listing
endpoints — see that endpoint's errors below).

### `GET /api/v1/nodes/nearby`

Any authenticated role. Proximity search — always `active` and publicly-visible only
regardless of caller, since its entire purpose is "where can I actually drop off a
parcel right now." Backed by a PostGIS `ST_DWithin`/`ST_Distance` query against a
GiST-indexed geography column.

Query params (all required except pagination): `latitude`, `longitude`, `radiusKm`
(0.1–100), plus `page`/`limit`.

Response `200`, `data.items[]`: same shape as the list response above, plus
`distanceMeters` (straight-line distance from the query point), sorted nearest-first.

Errors: `400 VALIDATION_FAILED` (missing/out-of-range lat/lng/radius).

### `GET /api/v1/nodes/:id`

Any authenticated role. Non-Admins get `404 NOT_FOUND` for a Node that exists but isn't
`active` — same shape as "doesn't exist," so pending/suspended Nodes can't be
fingerprinted by ID. Admins can fetch any Node regardless of status. Unlike the two list
endpoints above, this one does **not** additionally check `isPubliclyVisible` — a
private Node's name/address is still visible here to anyone who already has its id (the
real enforcement against booking against it lives in `POST /payments/intents`, not this
read endpoint — deliberate, matching how `GET /nodes/nearby`'s capacity filter has always
been UX-only, not the actual enforcement).

Response `200`, `data`: same shape as one list item.

Errors: `404 NOT_FOUND` (doesn't exist, or exists but hidden from your role),
`400 VALIDATION_FAILED` (malformed id).

### `PATCH /api/v1/nodes/:id`

**Requires an authenticated Admin session.** All fields optional — send only what's
changing. This is also how an Admin approves a pending Node (`{ "status": "active" }`)
or retires one (`{ "status": "inactive" }` / `"suspended"`) — there is no delete
endpoint, a Node is never removed, only status-transitioned.

Request (all optional): `name`, `address`, `city`, `state`, `country`, `latitude`,
`longitude`, `capacity`, `contactPhone`, `openingHours`, `operatingHours`, `status`,
`forceLocation`. Changing any address field or the coordinates re-runs the
[location check](#location-check) (`forceLocation: true` skips it — use this to correct a
pin for an address Google doesn't know). `onboardingType` is immutable after
creation and isn't accepted here. `isPubliclyVisible` also isn't accepted here — that's
owner-toggled via `PATCH /node-operators/nodes/:nodeId/visibility` below, not
Admin-set (Admin still sees the current value through this endpoint's response either
way).

Response `200`, `data`: the updated Node, same shape as one list item.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin), `400 VALIDATION_FAILED`,
`400 NODE_LOCATION_MISMATCH`, `404 NOT_FOUND`.

### `POST /api/v1/node-operators/onboarding`

**Requires an authenticated NodeOperator session** (role `node_operator` — set via
`POST /auth/register`'s `role` field). This is the second step of self-registration:
sets up the operator's *first* Node (location, capacity). Creates the `Node` (`status:
pending`, `onboardingType: portal`) and links it to your account, as `owner`, in one
action — the Node stays invisible in `/nodes`/`/nodes/nearby` for everyone except Admins
until an Admin approves it (`PATCH /node-operators/:id/approve` below).

**One operator can run more than one Node** — this endpoint is specifically for your
*first* one; calling it again once you've already onboarded returns `409
NODE_OPERATOR_ALREADY_ONBOARDED` pointing you at `POST /node-operators/nodes` below for
a 2nd/3rd location instead.

Request: same fields as `POST /nodes` **except no `onboardingType`** (forced to `portal`
server-side, not client-settable):

```json
{
  "name": "My Store Front",
  "address": "12 Admiralty Way",
  "city": "Lagos",
  "state": "Lagos",
  "country": "Nigeria",
  "latitude": 6.4500,
  "longitude": 3.4700,
  "capacity": 50,
  "contactPhone": "0803 123 4567",
  "openingHours": {
    "mon": [{ "open": "08:00", "close": "19:00" }],
    "sat": [{ "open": "09:00", "close": "14:00" }]
  }
}
```

`contactPhone` and `openingHours` are required, same rules as `POST /nodes`. The pin
goes through the same [location check](#location-check) — show `400
NODE_LOCATION_MISMATCH`'s message next to the map so the operator can move the pin.
`forceLocation` isn't accepted here (`400 VALIDATION_FAILED`); if Google genuinely doesn't
know the address the Node is simply saved as `unverified` for an Admin to review.

Response `201`, `data`:

```json
{
  "profileId": "uuid",
  "roleAtNode": "owner",
  "node": { "...": "same Node shape as GET /nodes/:id, status will be \"pending\"" },
  "payoutAccountConfigured": false,
  "payoutBankCode": null,
  "payoutBankName": null,
  "payoutAccountNumber": null,
  "payoutAccountName": null
}
```

`payoutAccountConfigured`/`payoutBank*`/`payoutAccount*` are always unset at this point —
see `PATCH /node-operators/nodes/:nodeId/payout-account` below. Frontend: use
`payoutAccountConfigured: false` to drive a "set up your payout account" prompt on the
operator's dashboard.

Requires `phone` to already be set on your account (`PATCH /users/me`) — registration no
longer collects it, and dispatch needs a real contact number. `400 PROFILE_INCOMPLETE` if
it isn't set yet.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a NodeOperator),
`400 VALIDATION_FAILED`, `400 PROFILE_INCOMPLETE`, `409 NODE_OPERATOR_ALREADY_ONBOARDED`.

### `POST /api/v1/node-operators/nodes`

**Requires an authenticated NodeOperator session who has already completed `POST
/node-operators/onboarding`** — this is how the *same* account adds a 2nd, 3rd, ...
location, without a second registration or login. Identical request/response shape to
`POST /node-operators/onboarding` above (`roleAtNode: "owner"`, `node.status: "pending"`,
same Admin-approval gate per Node). `400 NODE_OPERATOR_NOT_ONBOARDED` if you haven't
completed your first `POST /node-operators/onboarding` yet — do that first.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a NodeOperator),
`400 VALIDATION_FAILED`, `400 PROFILE_INCOMPLETE`, `400 NODE_OPERATOR_NOT_ONBOARDED`.

### `GET /api/v1/node-operators/me/nodes`

**Requires an authenticated NodeOperator session.** Every Node you have a membership at —
an array now, not a single object, since one operator can run several. Each item is the
same shape `POST /node-operators/onboarding` returns, tagged with `roleAtNode` . Empty array if you haven't onboarded yet — this replaced
the old singular `GET /node-operators/me`, which used to `404` in that case; check for an
empty array instead.

Response `200`, `data`: array of the onboarding-response shape.

### `PATCH /api/v1/node-operators/nodes/:nodeId/payout-account`

**Requires an authenticated NodeOperator session who owns `:nodeId`** (an `owner`
membership specifically). Sets (or replaces) that Node's
payout bank account. Verified against the real bank at submission time via Paystack — you
never type the account holder name yourself; it's resolved server-side and that's what
gets stored. Payout accounts are per-Node, not shared across every Node you run — set it
separately for each one.

First call `GET /api/v1/payments/banks` to get a `bankCode` to submit (see below).

Request:

```json
{ "bankCode": "058", "bankName": "Guaranty Trust Bank", "accountNumber": "0123456789" }
```

`accountNumber` must be exactly 10 digits (NUBAN). `bankName` is just a display label from
the bank list you already fetched — not itself verified, only `accountNumber`+`bankCode`
are checked against Paystack.

Response `200`, `data`: same shape as one `GET /node-operators/me/nodes` item, with the
new payout fields populated (`payoutAccountConfigured: true`, `payoutAccountName` set to
whatever Paystack resolved — never what you sent).

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a NodeOperator), `400 VALIDATION_FAILED`,
`404 NOT_FOUND` (`:nodeId` doesn't exist, or you don't have an owner membership there —
same "hide as not found" treatment as elsewhere, whether the Node exists at all isn't
revealed), `400 BANK_ACCOUNT_VERIFICATION_FAILED` (Paystack couldn't resolve that account
number at that bank — nothing is saved; any previously-verified payout account on file is
left untouched).

### `GET /api/v1/node-operators/pending`

**Requires an authenticated Admin session.** The review queue — Nodes still awaiting
approval, regardless of whether the owning operator's *account* has already been
approved before (an already-active operator's 2nd/3rd Node still needs its own review).
Paginated (see the pagination section above).

Response `200`, `data.items[]` each:

```json
{
  "profileId": "uuid",
  "userEmail": "operator@example.com",
  "userFirstName": "Ada",
  "userLastName": "Lovelace",
  "submittedAt": "2026-07-22T09:14:00.000Z",
  "node": { "...": "same Node shape as GET /nodes/:id, status will be \"pending\"" }
}
```

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin).

### `PATCH /api/v1/node-operators/:id/approve`

**Requires an authenticated Admin session.** `:id` is the `profileId` from the pending
queue above (not the Node id or the user id) — approving one Node, not "the operator" as
a whole. Flips the User's status to `active` and that Node's status to `active` together,
in one transaction (re-approving an already-active operator's account here is harmless —
it's a no-op on the User side, only the Node changes). After this, the Node shows up in
`/nodes`/`/nodes/nearby` for everyone.

No request body.

Response `200`, `data`: same shape as one `GET /node-operators/me/nodes` item, with
`node.status: "active"`.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin), `404 NOT_FOUND`
(no membership with that id).

### `POST /api/v1/node-operators/nodes/:nodeId/staff/invite`

**Requires an authenticated NodeOperator session who owns `:nodeId`** (an `owner`
membership specifically — a `staff` member inviting more staff is rejected the same way a
non-member is, `403 FORBIDDEN`, before this route's own logic even runs). `:nodeId` must
already be `active` 

Provisions a new `NODE_STAFF` account, invite-only just like Admin-provisioned accounts
(never self-registerable) — this is the *first* non-Admin invite path in the API, but it
goes through the exact same underlying mechanism: an email with an `/accept-invite?token=`
link, confirmed via the unchanged `POST /auth/invite/confirm` below. Staff can then log in
and perform handoff-scan operations at this Node (and any other Node they're later invited
to), but can't touch payout accounts, invite further staff, or see this Node's earnings —
those stay owner-only.

Request:

```json
{
  "firstName": "Chidi",
  "lastName": "Okafor",
  "email": "chidi@example.com",
  "phone": "+2348012345678"
}
```

Response `201`, `data`: same `UserResponseDto` shape `POST /users/invite` returns
(`status: "invited"`, `role: "node_staff"`, no `passwordHash`).

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a NodeOperator, or not this Node's
owner), `400 VALIDATION_FAILED`, `403 NODE_NOT_ACTIVE`, `404 NOT_FOUND` (`:nodeId` doesn't
exist, or you're not a member of it — same hide-as-not-found treatment as the
payout-account route), `409 EMAIL_ALREADY_REGISTERED`.

### `GET /api/v1/node-operators/nodes/:nodeId/staff`

**Requires an authenticated NodeOperator session who owns `:nodeId`.** The currently
active staff at this Node — there's no other way to see a staff member's `userId` again
after the initial invite response above, which `DELETE .../staff/:userId` below needs.
Removed staff don't appear here.

Response `200`, `data`, an array:

```json
[
  {
    "userId": "uuid",
    "firstName": "Chidi",
    "lastName": "Okafor",
    "email": "chidi@example.com",
    "joinedAt": "2026-07-22T09:14:00.000Z"
  }
]
```

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a NodeOperator), `404 NOT_FOUND`
(`:nodeId` doesn't exist, or you don't have an owner membership there — same
hide-as-not-found treatment as the payout-account route).

### `DELETE /api/v1/node-operators/nodes/:nodeId/staff/:userId`

**Requires an authenticated NodeOperator session who owns `:nodeId`.** Revokes that
staff member's access to this Node — a soft removal (the membership row's `status`
flips to `removed`), never a hard delete, so a Node's staffing history stays inspectable
at the DB level. Doesn't touch the staff
member's account or any other Node they're a member of — if they were invited to more
than one Node, those memberships are unaffected. Takes effect on their very next
request; there's no session/token to separately revoke.

`:userId` is a User id, not a membership id — the same `userId` `GET .../staff` above
returns.

No request body.

Response `204`, no body.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a NodeOperator), `404 NOT_FOUND`
(`:nodeId` doesn't exist or you don't own it, or `:userId` has no active membership at
this Node — including one already removed), `400 CANNOT_REMOVE_OWNER_MEMBERSHIP`
(`:userId` refers to an owner membership, not staff — not reachable through the normal
flow since `GET .../staff` only ever lists staff, but rejected directly if attempted).

### `PATCH /api/v1/node-operators/nodes/:nodeId/visibility`

**Requires an authenticated NodeOperator session who owns `:nodeId`** (an `owner`
membership specifically — same treatment as payout-account/staff-invite, `staff` gets the
same hide-as-not-found rejection as a non-member). `:nodeId` must already be `active`.

Toggles whether this Node appears in `GET /nodes` / `GET /nodes/nearby` for the general
public, and whether a Consumer can target it in `POST /payments/intents` at all (as
either the origin or the destination) — for a Node that only wants to dispatch its own
already-collected parcels through the network via `POST
/node-operators/nodes/:nodeId/dispatch` below, not accept public drop-offs. Setting this
doesn't touch any order already placed — same "enforced only at new-booking time, not
retroactively" precedent as the destination-Node-full behavior.

Request:

```json
{ "isPubliclyVisible": false }
```

Response `200`, `data`: same shape as one `GET /node-operators/me/nodes` item, with
`node.isPubliclyVisible` updated.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a NodeOperator), `400
VALIDATION_FAILED`, `403 NODE_NOT_ACTIVE`, `404 NOT_FOUND` (`:nodeId` doesn't exist, or
you don't have an owner membership there — same hide-as-not-found treatment as the
payout-account route).

### `PATCH /api/v1/node-operators/nodes/:nodeId/contact`

**Requires an authenticated NodeOperator session who owns `:nodeId`** (owner
membership — staff get the same hide-as-not-found rejection as non-members). Unlike
visibility, the Node does **not** need to be `active` — an owner can fill these in while
still pending approval, and this is how Nodes created before these fields existed get
them.

Sets the Node's counter phone (`contactPhone`) and/or weekly `openingHours`. Send either
or both; an omitted field is left unchanged. Same validation as `POST /nodes` (phone
normalised to E.164; see [Opening hours](#opening-hours)).

Request:

```json
{
  "contactPhone": "0902 555 1234",
  "openingHours": { "sat": [{ "open": "10:00", "close": "15:00" }] }
}
```

Response `200`, `data`: same shape as one `GET /node-operators/me/nodes` item, with
`node.contactPhone` / `node.openingHours` updated.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a NodeOperator), `400
VALIDATION_FAILED`, `404 NOT_FOUND` (`:nodeId` doesn't exist, or you don't own it).

### `POST /api/v1/node-operators/nodes/:nodeId/dispatch`

**Requires an authenticated NodeOperator or NodeStaff session with a membership at
`:nodeId`** (owner or staff — this is operational work, same as handoff scan/confirm, not
gated to owners only). `:nodeId` must already be `active`.

Places an order with `:nodeId` as the origin, on behalf of the operator's own business —
no Consumer account or app interaction on the sending side at all. Reuses the exact same
checkout flow `POST /payments/intents` uses underneath (Paystack hosted-redirect
checkout, the same capacity-reservation transaction, the same fee calculation), just
without a free-typed `originNodeId` — the origin is always `:nodeId` from the URL, so a
dispatching operator can never point an order at a Node they don't run. Unlike Consumer
bookings, the destination can be **any** active Node regardless of its own
`isPubliclyVisible` value — dispatching to another private Node (e.g. a partner's
internal station) is legitimate.

Request: same as `POST /payments/intents` **except no `originNodeId`**:

```json
{
  "destinationNodeId": "uuid",
  "receiverFullName": "Chinedu Okonkwo",
  "receiverEmail": "chinedu@example.com",
  "receiverPhone": "+2348012345678",
  "parcelDescription": "Documents, sealed envelope",
  "parcelSize": "small"
}
```

Response `201`, `data`: same shape as `POST /payments/intents`'s response (below) —
`authorizationUrl` is where the operator (or whoever pays) completes checkout, same as a
Consumer booking.  

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a NodeOperator/NodeStaff), `400
VALIDATION_FAILED`, `403 NODE_NOT_ACTIVE`, `404 NOT_FOUND` (`:nodeId` doesn't exist, or
you're not a member of it, or `destinationNodeId` doesn't exist / isn't `active` —
all hidden the same way), `409 NODE_CAPACITY_UNAVAILABLE`, `502 PAYMENT_PROVIDER_ERROR`.

### `GET /api/v1/riders/verification/upload-signature`

**Requires an authenticated Rider session.** Step one of rider onboarding: get a signed
authorization to upload a verification document *directly to Cloudinary* — the file
bytes never pass through this API. Call this, use the response to upload straight to
Cloudinary from the client, then pass the resulting `public_id` to
`POST /riders/onboarding` below.

Query params: `documentType` — only `rating_screenshot` exists today (a screenshot of
your ratings/reviews dashboard at the company you currently ride for).

Response `200`, `data`:

```json
{
  "signature": "...",
  "timestamp": 1785000000,
  "apiKey": "...",
  "cloudName": "...",
  "folder": "riders/{your-user-id}/verification/rating_screenshot"
}
```

How to use this to upload (client-side, direct to Cloudinary, not to this API):

```
POST https://api.cloudinary.com/v1_1/{cloudName}/image/upload
Content-Type: multipart/form-data

file=<the image>
api_key=<apiKey>
timestamp=<timestamp>
signature=<signature>
folder=<folder>
type=authenticated
```

Cloudinary's response includes a `public_id` — that's what you send to
`POST /riders/onboarding`.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a Rider), `400 VALIDATION_FAILED`
(unknown `documentType`).

### `POST /api/v1/riders/onboarding`

**Requires an authenticated Rider session.** Step two: submit the rest of your details
plus the `public_id` from the Cloudinary upload above. We confirm the upload actually
happened (via Cloudinary's Admin API) before accepting it — a stale or made-up
`public_id` is rejected. One rider profile per account; calling this twice returns
`409`.

Request:

```json
{
  "currentEmployer": "Existing Delivery Co",
  "licenseNumber": "ABJ-1234567",
  "documentType": "rating_screenshot",
  "cloudinaryPublicId": "riders/{your-user-id}/verification/rating_screenshot/abc123"
}
```

`licenseNumber` is self-reported, no format validation beyond length (1-50 chars) — no
photo/document verification of it exists (unlike `documentType`, which does get an actual
Cloudinary upload check). Not backfilled for riders who onboarded before this field
existed; `null` on their profile until further notice.

Response `201`, `data`:

```json
{
  "profileId": "uuid",
  "currentEmployer": "Existing Delivery Co",
  "licenseNumber": "ABJ-1234567",
  "status": "pending",
  "documents": [
    {
      "documentType": "rating_screenshot",
      "uploadedAt": "2026-07-22T09:14:00.000Z",
      "viewUrl": "https://res.cloudinary.com/.../authenticated/s--.../..."
    }
  ],
  "payoutAccountConfigured": false,
  "payoutBankCode": null,
  "payoutBankName": null,
  "payoutAccountNumber": null,
  "payoutAccountName": null
}
```

`viewUrl` is a signed, time-limited Cloudinary delivery URL, freshly generated on every
response — never store it, it's not permanent. `payoutAccountConfigured`/`payoutBank*`/
`payoutAccount*` are always unset at this point — see
`PATCH /riders/me/payout-account` below. Frontend: use `payoutAccountConfigured: false`
to drive a "set up your payout account" prompt on the rider's dashboard.

Requires `phone` to already be set on your account (`PATCH /users/me`) — registration no
longer collects it, and dispatch needs a real contact number. `400 PROFILE_INCOMPLETE` if
it isn't set yet.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a Rider), `400 VALIDATION_FAILED`,
`400 PROFILE_INCOMPLETE`, `400 INVALID_VERIFICATION_DOCUMENT` (the `cloudinaryPublicId`
doesn't correspond to a real upload), `409 RIDER_ALREADY_ONBOARDED`.

### `GET /api/v1/riders/me`

**Requires an authenticated Rider session.** Returns your own profile + documents — use
this to check whether you've been approved yet (`data.status`). `404 NOT_FOUND` if you
haven't completed onboarding yet.

Response `200`, `data`: same shape as the onboarding response.

### `PATCH /api/v1/riders/me/payout-account`

**Requires an authenticated Rider session.** Sets (or replaces) your payout bank
account — the account Admin disburses your earned revenue-split entries to (see
[Earnings](#earnings-revenue-split) below). Verified against the real bank at submission
time via Paystack — you never type the account holder name yourself; it's resolved
server-side and that's what gets stored.

First call `GET /api/v1/payments/banks` to get a `bankCode` to submit (see below).

Request:

```json
{ "bankCode": "058", "bankName": "Guaranty Trust Bank", "accountNumber": "0123456789" }
```

`accountNumber` must be exactly 10 digits (NUBAN). `bankName` is just a display label from
the bank list you already fetched — not itself verified, only `accountNumber`+`bankCode`
are checked against Paystack.

Response `200`, `data`: same shape as `GET /riders/me`, with the new payout fields
populated (`payoutAccountConfigured: true`, `payoutAccountName` set to whatever Paystack
resolved — never what you sent).

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a Rider), `400 VALIDATION_FAILED`,
`404 NOT_FOUND` (you haven't onboarded yet), `400 BANK_ACCOUNT_VERIFICATION_FAILED`
(Paystack couldn't resolve that account number at that bank — nothing is saved; any
previously-verified payout account on file is left untouched).

### `GET /api/v1/riders/pending`

**Requires an authenticated Admin session.** The review queue — Riders who have
registered and completed onboarding but aren't approved yet. Paginated.

Response `200`, `data.items[]` each:

```json
{
  "profileId": "uuid",
  "userEmail": "rider@example.com",
  "userFirstName": "Ada",
  "userLastName": "Lovelace",
  "currentEmployer": "Existing Delivery Co",
  "licenseNumber": "ABJ-1234567",
  "submittedAt": "2026-07-22T09:14:00.000Z",
  "documents": [ "...": "same document shape as the onboarding response" ]
}
```

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin).

### `PATCH /api/v1/riders/:id/approve`

**Requires an authenticated Admin session.** `:id` is the `profileId` from the pending
queue above. Approves the rider — flips the User's status and the RiderProfile's status
to `active` together, in one transaction.

No request body. There is no reject/decline endpoint yet.

Response `200`, `data`: same shape as the onboarding response, with `status: "active"`.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin), `404 NOT_FOUND`
(no profile with that id).

### `POST /api/v1/admin/pricing`

**Requires an authenticated Admin session.** Adds a new pricing rule, effective
immediately Rules are append-only: this never edits an existing rule, it adds a new one that becomes "current."

An environment with no pricing rule gets a **default one on deploy** (migration
`SeedDefaultPricingRule`): motorbike ₦1,100 + ₦320 per road-km, car ₦2,500 + ₦780 per
road-km, destination fee ₦300, road factor 1.4 — the placeholder rates below. It's skipped
if any rule already exists; post a new rule here to change prices.
Historical orders keep referencing whichever rule was current when their fee was
calculated, so past orders stay explainable even after rates change.

Request:

```json
{
  "baseFeeNaira": 1100,
  "perKmRateNaira": 320,
  "destinationFeeNaira": 300,
  "roadDistanceFactor": 1.4,
  "vehicleRates": { "car": { "baseFeeNaira": 2500, "perKmRateNaira": 780 } }
}
```

How a delivery fee is worked out (see [Pricing](#pricing)): `baseFeeNaira` /
`perKmRateNaira` are the **motorbike** rate, per **road** kilometre. Other vehicles use
`vehicleRates` when given (keys `bicycle`, `car`, `van`, `truck`), otherwise the motorbike
rate × a default multiplier (car 2.4, bicycle 0.7, van 5, truck 8). `roadDistanceFactor`
(optional, 1–3, default 1.4) estimates road km from the straight line until a courier has
measured that pair of Nodes. The values above are the current **placeholder** recommendation
(derived from Sendii sandbox quotes so the 60% courier allocation covers the courier's cost)
until the Locoomo–Sendii pricing formula is agreed.

`destinationFeeNaira` is a flat fee added to the order total and paid entirely to the
**destination** Node on order completion — it is not part of the rider/origin-Node/platform
revenue split (see `POST /admin/revenue-split` and the `destination_node` party type
below). 

Response `201`, `data`:

```json
{
  "id": "uuid",
  "baseFeeNaira": 500,
  "baseFeeKobo": 50000,
  "perKmRateNaira": 100,
  "perKmRateKobo": 10000,
  "destinationFeeNaira": 50,
  "destinationFeeKobo": 5000,
  "roadDistanceFactor": 1.4,
  "vehicleRates": {
    "car": { "baseFeeNaira": 2500, "baseFeeKobo": 250000, "perKmRateNaira": 780, "perKmRateKobo": 78000 }
  },
  "effectiveFrom": "2026-07-22T09:14:00.000Z",
  "createdByAdminId": "uuid"
}
```

Both units are returned — `*Kobo` is what's actually stored and what
`PaymentIntent.feeBreakdown` amounts are computed from; `*Naira` is just for display.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin), `400 VALIDATION_FAILED`.

### `GET /api/v1/admin/pricing`

**Requires an authenticated Admin session.** Rate history, newest first. Paginated.

Response `200`, `data.items[]`: same shape as the create response above.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin).

### `GET /api/v1/payments/banks`

**Requires an authenticated Rider or NodeOperator session.** Paystack's full list of
supported Nigerian banks — use this to populate a bank picker before calling
`PATCH /riders/me/payout-account` or `PATCH /node-operators/nodes/:nodeId/payout-account`.
Deliberately **not paginated** (flagged exception, same reasoning as
`GET /admin/capacity-audit`) — it's a wholesale reference list meant to back one
client-side dropdown/search, not a growing browsable resource.

Response `200`, `data`:

```json
[
  { "code": "058", "name": "Guaranty Trust Bank" },
  { "code": "011", "name": "First Bank of Nigeria" }
]
```

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a Rider or NodeOperator).

### Pricing

A delivery's price depends on **the vehicle the parcel needs** and **the road distance**:

1. **Vehicle** — the smallest vehicle class whose limits the parcel fits (current
   placeholder limits, configurable server-side):

   | Vehicle | Sizes | Max weight | Longest side |
   |---|---|---|---|
   | `motorbike` | small, medium | 20 kg | 60 cm |
   | `car` | small – extra_large | 50 kg | 120 cm |

   (Bicycle and van classes exist but are switched off.) Anything bigger or heavier is
   refused with `422 NO_DELIVERY_OPTION`.
2. **Distance** — road kilometres between the two Nodes: measured by a courier for that
   pair when known (`distanceSource: "route"`), otherwise the straight line × the pricing
   rule's factor (`"estimate"`).
3. **Fee** — the vehicle's base fee + per-km rate × distance (see
   [`POST /admin/pricing`](#post-apiv1adminpricing)), plus the destination Node's flat fee.

### `POST /api/v1/delivery-quotes`

**Requires an authenticated Consumer, NodeOperator or NodeStaff session.** Price preview
before payment — nothing is reserved. Call it whenever the Nodes or parcel details change.
Same body rules as `POST /payments/intents` (Nodes + parcel fields, no receiver details).
Consumers can only quote public Nodes; Node staff can also quote their own private ones
(for `dispatch`). Rate-limited to 30/min.

Request:

```json
{
  "originNodeId": "uuid",
  "destinationNodeId": "uuid",
  "parcelSize": "medium",
  "weightKg": 6.5,
  "lengthCm": 100,
  "widthCm": 30,
  "heightCm": 30,
  "handling": ["fragile"]
}
```

Response `200`, `data`:

```json
{
  "amountKobo": 1000560,
  "vehicleClass": "car",
  "estimatedDeliveryMinutes": 50,
  "distanceKm": 9.2,
  "feeBreakdown": { "…": "same shape as on a payment intent" },
  "validUntil": "2026-10-22T10:15:00.000Z"
}
```

`amountKobo` is what `POST /payments/intents` will charge for the same inputs (prices only
change when an Admin adds a pricing rule; `validUntil` is a sensible point to refresh).
`estimatedDeliveryMinutes` is a rough estimate of the courier leg only (after drop-off) —
present it as approximate.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `400 VALIDATION_FAILED`, `404 NOT_FOUND`
(Node missing, inactive, or private for a Consumer), `422 NO_DELIVERY_OPTION` (too
big/heavy for any vehicle, or no courier serves that vehicle between these Nodes — ask the
sender to adjust the parcel details or choose other Nodes), `429 RATE_LIMITED`, `503
PRICING_NOT_CONFIGURED`.

### `POST /api/v1/payments/intents`

**Requires an authenticated Consumer session.** Order placement — step one of the
delivery flow. Calculates the fee (distance between the two Nodes × the current pricing
rule), atomically reserves a capacity slot at the origin Node, and returns a Paystack
hosted-checkout URL to redirect the consumer to. The reservation holds for ~15 minutes;
if payment isn't completed by then it's released automatically. Rate-limited to 5
requests/min per IP, same as register/login.

Request:

```json
{
  "originNodeId": "uuid",
  "destinationNodeId": "uuid",
  "receiverFullName": "Chidinma Okafor",
  "receiverEmail": "receiver@example.com",
  "receiverPhone": "+2348012345678",
  "parcelDescription": "A small box of documents",
  "parcelSize": "small",
  "weightKg": 2.5,
  "lengthCm": 30,
  "widthCm": 20,
  "heightCm": 15,
  "handling": ["fragile"]
}
```

| Field | Rules |
|---|---|
| `receiverFullName` | 1–100 chars |
| `receiverEmail` | valid email |
| `receiverPhone` | `+` optional, 7–15 digits, same format as registration's `phone` |
| `parcelDescription` | 1–500 chars |
| `parcelSize` | one of `small`, `medium`, `large`, `extra_large` — together with weight and dimensions it decides the **vehicle**, and so the fee |
| `weightKg` | optional, 0.1–1000, at most 1 decimal. **Optional for now, will become required** — ask for it |
| `lengthCm`, `widthCm`, `heightCm` | optional integers 1–500 — send all three or none |
| `handling` | optional array of `fragile`, `keep_upright`, `perishable`, `liquid` (passed on to the courier) |

Call [`POST /delivery-quotes`](#post-apiv1delivery-quotes) first to show the price; this
endpoint charges exactly what the quote showed for the same inputs.

Response `201`, `data`:

```json
{
  "id": "uuid",
  "originNodeId": "uuid",
  "destinationNodeId": "uuid",
  "receiverFullName": "Chidinma Okafor",
  "receiverEmail": "receiver@example.com",
  "receiverPhone": "+2348012345678",
  "parcelDescription": "A small box of documents",
  "parcelSize": "small",
  "parcel": {
    "parcelSize": "small",
    "weightKg": 2.5,
    "lengthCm": 30,
    "widthCm": 20,
    "heightCm": 15,
    "handling": ["fragile"],
    "vehicleClass": "motorbike"
  },
  "feeBreakdown": {
    "pricingRuleId": "uuid",
    "vehicleClass": "motorbike",
    "baseFeeKobo": 110000,
    "perKmRateKobo": 32000,
    "distanceKm": 5.88,
    "distanceSource": "estimate",
    "straightLineKm": 4.2,
    "deliveryFeeKobo": 298160,
    "destinationFeeKobo": 30000,
    "totalKobo": 328160
  },
  "amountKobo": 328160,
  "status": "pending",
  "expiresAt": "2026-07-22T09:29:00.000Z",
  "authorizationUrl": "https://checkout.paystack.com/..."
}
```

Redirect the consumer's browser to `authorizationUrl` next — that's the actual payment
page, hosted by Paystack. After payment, Paystack
redirects back to `{FRONTEND_URL}/orders/payment-callback?...`; that redirect is
UI-only and does **not** mean payment succeeded (only the server-to-server webhook
confirms that) — land the consumer on a "processing" screen and poll `GET
/payments/intents/:id` until `status` leaves `"pending"`.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Consumer), `400 VALIDATION_FAILED`,
`404 NOT_FOUND` (either Node doesn't exist, isn't active, or is `isPubliclyVisible:
false` — a private Node is hidden from a Consumer the same way a nonexistent one is, not
a `403`), `409 NODE_CAPACITY_UNAVAILABLE`, `422 NO_DELIVERY_OPTION`, `429 RATE_LIMITED`,
`502 PAYMENT_PROVIDER_ERROR`, `503 PRICING_NOT_CONFIGURED`.

Show `totalKobo`/`amountKobo`; treat the rest of `feeBreakdown` as informational (the
formula is a placeholder until the courier pricing agreement is final). The parcel details
and `vehicleClass` are kept on the order (`parcel` on order responses).

Node-operators dispatching their own parcels (no Consumer involved) use `POST
/node-operators/nodes/:nodeId/dispatch` instead, not this endpoint — see that section
above for why it's a separate route rather than this one gaining more roles.

### `GET /api/v1/payments/intents/:id`

**Requires an authenticated Consumer session**, and only returns your own intents
(`404 NOT_FOUND` otherwise, not `403` — same not-found-not-forbidden pattern used
elsewhere for ownership checks). Poll this after the Paystack redirect to find out
whether the payment actually went through.

Response `200`, `data`: same shape as the create response, minus `authorizationUrl`
(Paystack's checkout link is single-use — nothing to redirect to on a status check).
`status` is one of `pending` (still waiting on payment), `paid` (succeeded — an Order now
exists, viewable via `GET /orders/:id`), `failed`, or `expired` (the ~15 minute hold
lapsed unpaid).

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Consumer), `404 NOT_FOUND`.

### `POST /api/v1/payments/webhooks/paystack`

Server-to-server only — Paystack calls this, your frontend never does. Listed here only
for completeness. Unauthenticated (no session cookie involved), verified instead via
Paystack's HMAC signature header.

### `POST /api/v1/logistics/webhooks/:providerKey`

Server-to-server only — courier partners (e.g. Sendii, `/sendii`) call this, your frontend
never does. Listed for completeness. Verified by the courier's signature header, not a
session.

### `GET /api/v1/orders`

**Requires an authenticated Consumer session.** Lists only the requesting consumer's own
orders — there is no "all orders" view for a Consumer. Paginated (see
[Pagination](#pagination-list-endpoints)).

Response `200`, `data`:

```json
{
  "items": [
    {
      "id": "uuid",
      "trackingCode": "LCM-4F2K-9XPT",
      "paymentIntentId": "uuid",
      "originNodeId": "uuid",
      "originNodeName": "Ikeja Node",
      "originNodeAddress": "12 Allen Avenue, Ikeja",
      "destinationNodeId": "uuid",
      "destinationNodeName": "Lekki Node",
      "destinationNodeAddress": "45 Admiralty Way, Lekki Phase 1",
      "receiverFullName": "Chidinma Okafor",
      "receiverEmail": "receiver@example.com",
      "receiverPhone": "+2348012345678",
      "parcelDescription": "A small box of documents",
      "parcelSize": "small",
      "amountKobo": 92000,
      "status": "awaiting_drop_off",
      "createdAt": "2026-07-22T09:29:00.000Z",
      "trackingUrl": "https://app.locoomo.com/track/LCM-4F2K-9XPT?t=Zk3qW1…",
      "labelInstructions": {
        "lines": ["LCM-4F2K-9XPT", "TO: LEKKI NODE"],
        "note": "Write this clearly on the parcel with a marker before drop-off."
      },
      "delivery": null
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

- `trackingUrl` — the public tracking page for this parcel (see [`GET
  /track/:trackingCode`](#get-apiv1tracktrackingcode)). Offer a **"Share tracking link"**
  button (WhatsApp/SMS share sheet) so the sender can pass it to the receiver. It contains
  a signed token, so don't log it or send it to analytics.
- `parcel` — the parcel details captured at checkout (`parcelSize`, `weightKg`,
  `lengthCm`/`widthCm`/`heightCm`, `handling`) and the `vehicleClass` they need. Fields
  not given at checkout are `null` (`handling`: `[]`). Also on the Node app's
  `by-tracking-code` and `my-node/orders` items.
- `delivery` — who is carrying the parcel; see [Delivery object](#delivery-object).
  `null` until the parcel is dropped off. Never includes the courier's phone for a
  Consumer.
- `labelInstructions` — Pickup Stations have no printers, so the sender labels the parcel
  by hand. While `status` is `awaiting_drop_off`, show `lines` large, one per line, exactly
  as they should be written, with `note` above them. The same instructions are in the
  order confirmation email.

`trackingCode` is a human-friendly reference for the consumer to quote (support calls,
order confirmation UI) — `LCM-` followed by 8 characters from a Crockford-Base32-style
alphabet (excludes `0`/`O`, `1`/`I`/`L` so it can't be misread aloud or mistyped). It is
**not** an authentication/collection code. Use `id`, not `trackingCode`, as the path
param below and everywhere else you'd reference an order programmatically —
`trackingCode` is display-only.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Consumer), `400 VALIDATION_FAILED`.

### `GET /api/v1/orders/:id`

**Requires an authenticated Consumer session**, and only returns your own orders (`404
NOT_FOUND` otherwise, not `403` — same not-found-not-forbidden pattern as
`GET /payments/intents/:id`).

Response `200`, `data`: same shape as one item from the list response above.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Consumer), `404 NOT_FOUND`.

### `GET /api/v1/handoffs/available-orders`

**Requires an authenticated Rider session, and your `RiderProfile` must be `active`**
(rejected `403 RIDER_NOT_ACTIVE` otherwise, even with a valid Rider role — see
`POST /riders/onboarding` and Admin approval). Lists orders sitting unclaimed at their
origin Node (`status: parcel_received_at_origin`, no rider assigned yet) that have been
routed to Locoomo riders — orders being carried by an external courier never appear, and an
order can appear some time after drop-off if a courier couldn't take it. Sorted
nearest-first to the coordinates you supply. Nothing about your location is stored —
`latitude`/`longitude` are used for this one request's sort only. Paginated (see
[Pagination](#pagination-list-endpoints)).
 
Query params: `latitude`, `longitude` (required), `page`, `limit`.

Response `200`, `data`:

```json
{
  "items": [
    {
      "id": "uuid",
      "trackingCode": "LCM-4F2K-9XPT",
      "originNodeId": "uuid",
      "originNodeName": "Ikeja Node",
      "originNodeAddress": "12 Allen Avenue, Ikeja",
      "destinationNodeId": "uuid",
      "destinationNodeName": "Lekki Node",
      "destinationNodeAddress": "45 Admiralty Way, Lekki Phase 1",
      "parcelDescription": "A small box of documents",
      "parcelSize": "small",
      "createdAt": "2026-07-22T09:29:00.000Z",
      "distanceMeters": 4213.7
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

No receiver name/email/phone here — deciding whether to accept a job doesn't need
receiver PII, only route/size/distance.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Rider), `403 RIDER_NOT_ACTIVE`,
`400 VALIDATION_FAILED`.

### `POST /api/v1/handoffs/orders/:id/accept`

**Requires an authenticated, `active` Rider session.** Claims an available order —
atomic, race-safe against other riders accepting the same order simultaneously (only one
wins; the other gets `409 ILLEGAL_ORDER_TRANSITION`), and capped at 3 concurrent active
deliveries per rider (`409 RIDER_CAPACITY_UNAVAILABLE` past that).

Response `200`, `data`:

```json
{
  "id": "uuid",
  "trackingCode": "LCM-4F2K-9XPT",
  "status": "rider_assigned",
  "originNodeId": "uuid",
  "destinationNodeId": "uuid",
  "shelfNumber": 17
}
```

`shelfNumber` is the number written on the parcel at the Node it's sitting at right now
(see [Shelf numbers](#shelf-numbers)) — `null` while it's with a rider or once collected.
Every handoff endpoint below that says "same shape as the accept response" includes it.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Rider), `403 RIDER_NOT_ACTIVE`,
`409 ILLEGAL_ORDER_TRANSITION` (order already claimed, not yet at
`parcel_received_at_origin`, or handed to an external courier since you listed it —
refresh the list), `409 RIDER_CAPACITY_UNAVAILABLE`.

### `GET /api/v1/handoffs/my-orders`

**Requires an authenticated Rider session.** The counterpart to `accept` — every order
you've ever been assigned, current and past, newest first. No status filtering server-side
— use `status` on each item to tell what still needs action (`rider_assigned` needs a
pickup code, `in_transit` needs an arrival code) apart from settled ones. Paginated (see
[Pagination](#pagination-list-endpoints)).

Response `200`, `data`:

```json
{
  "items": [
    {
      "id": "uuid",
      "trackingCode": "LCM-4F2K-9XPT",
      "status": "rider_assigned",
      "originNodeId": "uuid",
      "originNodeName": "Yaba Node",
      "originNodeAddress": "12 Herbert Macaulay Way",
      "destinationNodeId": "uuid",
      "destinationNodeName": "Lekki Node",
      "destinationNodeAddress": "5 Admiralty Way",
      "parcelDescription": "A small box of documents",
      "parcelSize": "small",
      "createdAt": "2026-07-22T09:14:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

No receiver details here — same reasoning as `available-orders`, you don't need them
until the destination side of the flow.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Rider).

### `GET /api/v1/handoffs/my-node/orders`

**Requires an authenticated NodeOperator or NodeStaff session** — operating a Node's
handoffs isn't owner-only, so staff invited to a Node get the same access here as its
owner. The counterpart to `my-orders`, for the other side of the counter — every order
that's ever touched **any** Node you have a membership at, either as origin or
destination, current and past, newest first. `myRole` on each item tells you which side
that order's Node played (a Node is an origin for some orders and a destination for
others). Paginated (see [Pagination](#pagination-list-endpoints)).

Optional `queue` query param narrows this to one of the counter's work queues:

| `queue` | Returns |
|---|---|
| `to_receive` | Paid orders waiting to be dropped off at your Node (`awaiting_drop_off`) |
| `to_dispatch` | On your shelf, waiting for or being handed to a rider (`parcel_received_at_origin`, `rider_assigned`) |
| `incoming` | On the way to your Node: a delivery (`rider_assigned`, `in_transit`), or a return coming back to you as the origin (`return_initiated`, `return_in_transit`) |
| `to_collect` | At your counter to shelve or hand over: a delivery for its receiver (`arrived_at_destination`, `ready_for_collection`), or a returned parcel for its sender (`returned_to_origin`, `ready_for_sender_collection`) |
| *(omitted)* | Everything, as before |

Any other value is `400 VALIDATION_FAILED`.

Response `200`, `data`:

```json
{
  "items": [
    {
      "id": "uuid",
      "trackingCode": "LCM-4F2K-9XPT",
      "status": "parcel_received_at_origin",
      "originNodeId": "uuid",
      "originNodeName": "Yaba Node",
      "destinationNodeId": "uuid",
      "destinationNodeName": "Lekki Node",
      "parcelDescription": "A small box of documents",
      "parcelSize": "small",
      "createdAt": "2026-07-22T09:14:00.000Z",
      "myRole": "origin",
      "nextAction": "await_courier",
      "shelfNumber": 17,
      "receiverMasked": "C. O. · ***5678"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

`myRole`, `nextAction`, `shelfNumber`, `receiverMasked` and `delivery` mean the same as
in `by-tracking-code` below. Still no full receiver details — this is an overview, not the
collection step.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator/NodeStaff).

### `GET /api/v1/handoffs/orders/by-tracking-code/:code`

**Requires an authenticated NodeOperator or NodeStaff session.** The Node app's one "scan"
lookup — call it with whatever the operator typed or scanned, at **either end** of the
journey: it returns orders whose origin *or* destination is one of your Nodes (`404
NOT_FOUND` otherwise — not-found-not-forbidden, same pattern as everywhere else).

**Input is forgiving**, because codes are typed off handwritten labels. Send it exactly as
entered — don't normalise client-side. The server ignores case, spaces and dashes, accepts
the code with or without the `LCM` prefix, reads `O` as `0` and `I`/`L` as `1`, and accepts
a whole pasted tracking URL (`…/track/LCM-4F2K-9XPT?t=…`). So `4f2k 9xpt` finds
`LCM-4F2K-9XPT`. URL-encode it in the path. Anything that can't be a tracking code is a
plain `404`.

Response `200`, `data`:

```json
{
  "id": "uuid",
  "trackingCode": "LCM-4F2K-9XPT",
  "status": "rider_assigned",
  "originNodeId": "uuid",
  "originNodeName": "Yaba Node",
  "destinationNodeId": "uuid",
  "destinationNodeName": "Lekki Node",
  "parcelDescription": "A small box of documents",
  "parcelSize": "small",
  "createdAt": "2026-07-22T09:29:00.000Z",
  "myRole": "origin",
  "nextAction": "hand_to_rider",
  "shelfNumber": 17,
  "receiverMasked": "C. O. · ***5678",
  "delivery": {
    "provider": "in_house",
    "providerLabel": "Locoomo rider",
    "type": "forward",
    "status": "assigned",
    "vehicleClass": null,
    "handover": "enter_rider_code",
    "courier": { "name": "Tunde A.", "phone": "+2348031234567", "vehicle": null },
    "etaMinutes": null,
    "attemptNumber": 1,
    "updatedAt": "2026-10-21T09:41:00.000Z"
  }
}
```

| Field | Meaning |
|---|---|
| `myRole` | `origin` or `destination` — the side *your* Node plays in this order. If you're a member at both Nodes, it's whichever side the parcel's business is currently at |
| `nextAction` | What staff at your Node should do now — drive the main button off this rather than re-deriving it from `status`. Values below |
| `shelfNumber` | The number on the parcel at **your** Node, `null` if it isn't on one of your shelves |
| `receiverMasked` | Initials and the last 4 phone digits — enough to match the parcel to the person at the counter. Full receiver details stay collection-only |
| `delivery` | Who is carrying it — see [Delivery object](#delivery-object). The courier's `phone` is included here (staff may need to call them) |

| `nextAction` | Show | Calls |
|---|---|---|
| `confirm_drop_off` | "Receive parcel" | `POST /handoffs/orders/:id/drop-off` |
| `await_courier` | "Waiting for a rider" (no button) | — |
| `hand_to_rider` | "Hand to rider — enter their code" | `POST /handoffs/orders/:id/confirm-handoff` (`rider_pickup`) |
| `hand_to_courier` | "Hand to courier — give them the code" (external courier) | [`GET /handoffs/orders/:id/courier-handover`](#get-apiv1handoffsordersidcourier-handover) |
| `await_arrival` | "On the way to you" (no button) | — |
| `receive_from_rider` | "Receive from rider — enter their code" | `POST /handoffs/orders/:id/confirm-handoff` (`rider_arrival`) |
| `receive_from_courier` | "Receive from courier — give them the code" (external courier; also a returning courier at the origin) | [`GET /handoffs/orders/:id/courier-handover`](#get-apiv1handoffsordersidcourier-handover) |
| `intake` | "Shelve parcel" | `POST /handoffs/orders/:id/intake` |
| `hand_to_receiver` | "Hand to receiver" | `POST /handoffs/orders/:id/collect` |
| `return_intake` | "Returned parcel — shelve it" (origin) | `POST /handoffs/orders/:id/return-intake` |
| `hand_to_sender` | "Hand back to sender" (origin) | `POST /handoffs/orders/:id/return-collect` |
| `none` | Read-only | — |

Give any value you don't recognise a read-only default rather than crashing.

#### Delivery object

Who is carrying the parcel between the two Nodes, in courier-neutral terms — the same
shape whether it's a Locoomo rider or an external courier. It's the order's current
delivery attempt, or the latest one once finished; `null` before drop-off. An order can
go through several attempts (a courier couldn't find a rider and the parcel went to the
Locoomo rider pool instead), which `attemptNumber` counts.

| Field | Meaning |
|---|---|
| `provider` | Courier id, e.g. `in_house`. **Treat as opaque** — new couriers appear without a frontend release; only use it for optional branding |
| `providerLabel` | Display name — show this |
| `type` | `forward` (to the destination) or `return` |
| `status` | `requested` (waiting for a rider), `assigned`, `picked_up`, `delivered`, `returning`, `returned`, `cancelled` (this attempt ended; another follows automatically) |
| `vehicleClass` | `bicycle`, `motorbike`, `car`, `van`, `truck`, or `null` |
| `handover` | How the next counter handover works: `enter_rider_code` (the rider shows a code, staff enter it) or `give_code_to_courier` (staff read the courier a code). `nextAction` already accounts for it |
| `courier` | `{ name, phone, vehicle }` once someone is assigned, else `null`. `phone` only in the Node app responses |
| `etaMinutes` | The courier's estimate, often `null` — not a promise |
| `attemptNumber` | 1, 2, … across retries and fallbacks |
| `updatedAt` | Last change |

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator/NodeStaff), `404 NOT_FOUND`.

#### Shelf numbers

Pickup Stations have no printers, so parcels are identified by hand-written numbers. When a
Node takes a parcel in — **drop-off** at the origin, **intake** at the destination — the
API assigns it the lowest number not in use at that Node (`1`, `2`, `3`, …) and returns it
as `shelfNumber`. Show it big with "Write **#17** on the parcel" next to the tracking code.
Numbers are unique per Node (across parcels going out and coming in, since it's one shelf)
and are freed when the parcel leaves — rider pickup at the origin, collection at the
destination — so they stay short.

### `POST /api/v1/handoffs/orders/:id/drop-off`

**Requires an authenticated NodeOperator or NodeStaff session**, ownership-scoped the same
way as the lookup above. Confirms the consumer has physically handed over the parcel —
`awaiting_drop_off → parcel_received_at_origin`. Idempotent: calling this twice for the
same order is a safe no-op the second time, same response either way.

Response `200`, `data`: same shape as the accept response above, `status:
"parcel_received_at_origin"`, with the parcel's new [`shelfNumber`](#shelf-numbers) at
your Node. This step also emails the receiver for the first time — "a parcel is on its way
to you", with the tracking code, a QR code and the tracking link.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator/NodeStaff), `404 NOT_FOUND` (not
your Node), `409 ILLEGAL_ORDER_TRANSITION` (order isn't at `awaiting_drop_off`).

### `POST /api/v1/handoffs/orders/:id/request-code`

**Requires an authenticated, `active` Rider session, and you must be the rider assigned
to this specific order** (`404 NOT_FOUND` otherwise — a rider who never accepted this
order can't get a code for it; there's nothing to show a Node operator even
if you tried). Issues a fresh 6-digit code for the handoff you're about to do — request
it right before you're physically at the counter, not in advance, since it expires in 5
minutes. Requesting again supersedes any prior unused code for the same `(order, type)`.

Request:

```json
{ "type": "rider_pickup" }
```

`type` is `rider_pickup` (you're at the origin Node about to take the parcel) or
`rider_arrival` (you're at the destination Node about to hand it off) — nothing else is
accepted here.

Response `201`, `data`:

```json
{ "code": "482913", "expiresAt": "2026-07-22T09:34:00.000Z" }
```

Show or read this code to the Node operator — never send it anywhere else, it's not
logged or emailed.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Rider), `403 RIDER_NOT_ACTIVE`,
`404 NOT_FOUND` (not your order), `400 VALIDATION_FAILED`.

### `GET /api/v1/handoffs/orders/:id/courier-handover`

**Requires an authenticated NodeOperator or NodeStaff session** at the Node doing the
handover right now. For **external couriers** (`delivery.handover:
"give_code_to_courier"`, `nextAction` `hand_to_courier` / `receive_from_courier`): returns
the code staff read out to the courier, who enters it in their own app. The order then
moves on by itself a few seconds later (poll `by-tracking-code` every 3–5 s for up to
2 minutes to show "Handed over ✓").

Response `200`, `data`:

```json
{
  "kind": "pickup",
  "code": "731942",
  "courier": { "name": "Musa A.", "phone": "+2348031112222", "vehicle": "motorbike" },
  "providerLabel": "Sendii",
  "shelfNumber": 17,
  "trackingCode": "LCM-4F2K-9XPT"
}
```

- `kind`: `pickup` (origin Node, courier assigned), `delivery` (destination Node, parcel
  in transit) or `return_delivery` (origin Node, a failed delivery coming back — see
  [Returns](#returns)).
- Flow: scan the parcel → check the courier's name against `courier.name` → **read out
  `code`** → the courier enters it.
- **The code is a credential** — whoever holds it can take the parcel. Don't store, log,
  cache or send it to analytics; fetch it fresh each time the screen opens (the response
  is `Cache-Control: no-store`); never put it in a URL.
- It's fetched live from the courier, so it can take a couple of seconds and can fail with
  `502` — show "Couldn't load the code, try again".

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator/NodeStaff), `404
NOT_FOUND` (not your Node), `409 COURIER_HANDOVER_NOT_AVAILABLE` (no courier assigned yet,
already handed over, your Node isn't the side handing over, or the delivery uses Locoomo
rider codes — refresh and follow `nextAction`), `502 LOGISTICS_PROVIDER_ERROR`, `429
RATE_LIMITED` (20/min).

### `POST /api/v1/handoffs/orders/:id/confirm-handoff`

**Requires an authenticated NodeOperator or NodeStaff session, ownership-scoped to the
correct side** — `type: "rider_pickup"` must come from someone with a membership at the
*origin* Node, `type: "rider_arrival"` from the *destination* Node (`404 NOT_FOUND` from
the wrong one, same not-found-not-forbidden pattern as everything else). This is what you call
after the rider shows/states their code. Rate-limited (10/min) on top of a per-code
lockout — 5 wrong guesses locks that code out permanently; the rider has to request a
new one, they aren't blocked from trying again.

Request:

```json
{ "type": "rider_pickup", "code": "482913" }
```

Response `200`, `data`: same shape as the accept response, `status` becomes `in_transit`
(pickup) or `arrived_at_destination` (arrival). Idempotent — a retried confirm with the
same already-used code returns the same success, not an error.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator/NodeStaff), `404 NOT_FOUND` (wrong
Node for this `type`), `401 INVALID_HANDOFF_CODE`, `429 RATE_LIMITED`,
`400 VALIDATION_FAILED`.

### `POST /api/v1/handoffs/orders/:id/intake`

**Requires an authenticated NodeOperator or NodeStaff session**, ownership-scoped to the
*destination* Node (`404 NOT_FOUND` otherwise). Destination-side equivalent of drop-off —
confirms the parcel has physically arrived at your counter (the rider already moved it to
`arrived_at_destination` via `confirm-handoff`). `arrived_at_destination →
ready_for_collection`. In the same step, mints a 6-digit collection code and emails it to
the receiver — you never see the code yourself, only the receiver does. Idempotent:
calling this twice is a safe no-op the second time.

Response `200`, `data`: same shape as the accept response above, `status:
"ready_for_collection"`, with the parcel's new [`shelfNumber`](#shelf-numbers) at your
Node. The collection-code email also carries the tracking code, QR code and link.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator/NodeStaff), `404 NOT_FOUND` (not
your Node), `409 ILLEGAL_ORDER_TRANSITION` (order isn't at `arrived_at_destination`).

### `POST /api/v1/handoffs/orders/:id/collection-code/resend`

**Requires an authenticated NodeOperator or NodeStaff session**, ownership-scoped to the
destination Node. Use this when the receiver is standing at the counter but says they never got the
email, or their original code expired (1 hour TTL) — mints a fresh code, superseding the
prior one, and re-emails it. Rate-limited (5/min) since it sends a real email each time.

For a **returned** parcel (`status: ready_for_sender_collection`) it's the origin Node that
calls this, and the fresh code goes to the **sender** — see [Returns](#returns).

No request body. Response `200`, `data`:

```json
{ "expiresAt": "2026-07-22T10:34:00.000Z" }
```

The code itself is never in this response — it only ever goes to the receiver's email,
never to the operator's session or any API response, the mirror image of the rider
pickup/arrival codes (which are only ever shown to the rider, never emailed).

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator/NodeStaff), `404 NOT_FOUND` (not
your Node), `409 ORDER_NOT_READY_FOR_COLLECTION` (intake hasn't run yet, or the order's
already `completed`), `429 RATE_LIMITED`.

### `POST /api/v1/handoffs/orders/:id/collect`

**Requires an authenticated NodeOperator or NodeStaff session**, ownership-scoped to the
destination Node. Final step — the receiver reads you the code from their email, you ask for and
confirm their name, then call this. `ready_for_collection → completed`. Rate-limited
(10/min) on top of the same per-code lockout as pickup/arrival (5 wrong guesses locks
that code out permanently; resend recovers it).

`identityConfirmed` is your attestation that you asked for and matched the receiver's
name — it's recorded on the order's permanent event log but does **not** block
completion if `false`. Legitimate proxy pickup (someone other than the named receiver
collecting on their behalf) is common in this business; this isn't a system-enforced
identity check, just an audit trail of whether you did it.

Request:

```json
{ "code": "738204", "identityConfirmed": true }
```

Response `200`, `data`: same shape as the accept response, `status` becomes `completed`.
Idempotent — a retried confirm with the same already-used code returns the same success,
not an error.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator/NodeStaff), `404 NOT_FOUND` (wrong
Node), `401 INVALID_HANDOFF_CODE`, `429 RATE_LIMITED`, `400 VALIDATION_FAILED`,
`503 REVENUE_SPLIT_NOT_CONFIGURED` (Admin hasn't set a revenue-split ratio yet — see the
`earnings` endpoints below).

This is also the end of the parcel's lifecycle in the system today. The moment an order
reaches `completed`, its revenue is split and recorded — see the `earnings` endpoints
below, which is where that money is actually tracked. Payout itself is still manual (an
Admin disburses off-system); these endpoints are the record of what's owed, not a payout
flow.

## Returns

When a courier can't complete a delivery (e.g. the destination station was closed for every
attempt) it brings the parcel **back to the origin Pickup Station**, where the **sender**
collects it. No return fee is charged. Today only external couriers (Sendii) return
parcels this way.

| Order `status` | Meaning | Who's notified |
|---|---|---|
| `return_initiated` | The delivery couldn't be completed (usually passes straight on to the next status) | — |
| `return_in_transit` | Courier is bringing it back to the origin station | Sender ("Your parcel is being returned") and receiver ("could not be delivered") by email |
| `returned_to_origin` | Courier handed it back at the origin counter | — |
| `ready_for_sender_collection` | Origin staff shelved it; the sender has a collection code | Sender, with the code |
| `return_completed` | The sender collected it — final | — |

Show these on the sender's order screen with the origin station (`originNodeName`,
`originNodeAddress`) as the collection point. For the Node app, the origin station's
`nextAction` walks through the return: `receive_from_courier` (read the returning courier
the code from `courier-handover`, `kind: "return_delivery"`), then `return_intake`, then
`hand_to_sender`. Returned parcels show in the origin's `incoming` and `to_collect`
queues.

### `POST /api/v1/handoffs/orders/:id/return-intake`

**Requires an authenticated NodeOperator or NodeStaff session** at the **origin** Node
(`404 NOT_FOUND` otherwise). The returned parcel is on your counter: `returned_to_origin →
ready_for_sender_collection`. Assigns it a [shelf number](#shelf-numbers) and emails the
**sender** a 6-digit collection code (1 hour TTL; resend with
`POST /handoffs/orders/:id/collection-code/resend`). Idempotent.

Response `200`, `data`: same shape as the accept response, with `shelfNumber`.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator/NodeStaff), `404 NOT_FOUND`,
`409 ILLEGAL_ORDER_TRANSITION` (not at `returned_to_origin`).

### `POST /api/v1/handoffs/orders/:id/return-collect`

**Requires an authenticated NodeOperator or NodeStaff session** at the **origin** Node. The
sender reads you the code from their email: `ready_for_sender_collection →
return_completed`. Same request, rules, rate limit and lockout as
[`collect`](#post-apiv1handoffsordersidcollect):

```json
{ "code": "738204", "identityConfirmed": true }
```

Response `200`, `data`: same shape as the accept response, `status: "return_completed"`,
`shelfNumber: null`. No revenue split is recorded — the parcel was never delivered.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND` (not your origin Node), `401
INVALID_HANDOFF_CODE`, `429 RATE_LIMITED`, `400 VALIDATION_FAILED`.

## Public tracking

The receiver has no account, so parcels can be tracked without logging in — on a frontend
page at `{FRONTEND_URL}/track/:trackingCode` that calls the endpoint below. People reach it
two ways:

1. **From an email link** (or one the sender shared from `trackingUrl`):
   `/track/LCM-4F2K-9XPT?t=<token>` — pass `t` through to the API.
2. **Typed**: a form asking for the tracking code and "last 4 digits of the receiver's
   phone number" — pass those as `phoneLast4`.

Page requirements: `<meta name="robots" content="noindex">` and `Referrer-Policy:
no-referrer` (so the token never leaks to other sites); never store `t` (no localStorage,
strip it from analytics page views); re-fetch every 60 s while visible and `isFinal` is
false.

Emails that link here: the sender's order confirmation, the receiver's "a parcel is on its
way to you" (sent at drop-off), and the receiver's collection-code emails. Each also shows
the tracking code and a QR code of it to present at the station counter.

### `GET /api/v1/track/:trackingCode`

**Public — no session.** Query: exactly one of `t` (token from the link) or `phoneLast4`
(4 digits). The code is read as forgivingly as in the Node app's lookup. Rate-limited to
10 requests/min per IP.

Response `200`, `data`:

```json
{
  "trackingCode": "LCM-4F2K-9XPT",
  "status": "on_the_way",
  "statusLabel": "On the way",
  "isFinal": false,
  "timeline": [
    { "status": "order_placed", "label": "Order placed", "at": "2026-10-21T08:10:00.000Z" },
    { "status": "at_origin_station", "label": "Dropped off at Yaba Node", "at": "2026-10-21T09:29:00.000Z" },
    { "status": "at_origin_station", "label": "Rider assigned", "at": "2026-10-21T09:41:00.000Z" },
    { "status": "on_the_way", "label": "On the way to Lekki Node", "at": "2026-10-21T10:05:00.000Z" }
  ],
  "origin": { "name": "Yaba Node", "city": "Lagos" },
  "destination": {
    "name": "Lekki Node",
    "address": "45 Admiralty Way, Lekki Phase 1",
    "city": "Lagos",
    "state": "Lagos",
    "openingHours": { "mon": [{ "open": "08:00", "close": "18:00" }] }
  },
  "courierLabel": "Locoomo rider",
  "etaMinutes": null,
  "nextStep": "The parcel is on its way to Lekki Node. We'll email the receiver a collection code when it's ready.",
  "updatedAt": "2026-10-21T10:05:00.000Z"
}
```

| `status` | `statusLabel` |
|---|---|
| `awaiting_drop_off` | Awaiting drop-off |
| `at_origin_station` | At origin station (includes "rider assigned, not yet collected") |
| `on_the_way` | On the way |
| `arrived_at_destination` | Arrived at destination station |
| `ready_for_collection` | Ready for collection |
| `collected` | Collected (`isFinal: true`) |
| `returning_to_sender` | Returning to sender |
| `returned_to_sender` | Returned — ready for sender collection |
| `return_completed` | Returned to sender (`isFinal: true`) |

Render `statusLabel`, `nextStep` and the timeline `label`s as given — the copy is
server-side so it can change without a release. `destination.openingHours` can be `null`
(see [Opening hours](#opening-hours)); `courierLabel` is the carrying courier's display
name (e.g. "Locoomo rider", "Sendii"), `null` when no one is carrying the parcel;
`etaMinutes` is always `null` for now. During a return, `origin` also carries `address`,
`state` and `openingHours` — it's where the parcel is going. For any `status` you don't
recognise, fall back to showing `statusLabel`.

**Never returned:** names, phone numbers, emails, collection or handover codes, shelf
numbers, prices, internal ids.

Errors: `404 NOT_FOUND` for an unknown code, a wrong `t`, wrong `phoneLast4`, or a parcel
collected (or collected back by its sender) more than 30 days ago — deliberately identical, so show one "We couldn't find
that parcel. Check the code and try again." message. `400 VALIDATION_FAILED` (neither or
both of `t`/`phoneLast4`, or `phoneLast4` not 4 digits), `429 RATE_LIMITED`.

## Earnings (revenue split)

Every `completed` order produces four `revenue_split_entries` rows at the exact moment it
completes — see `POST /handoffs/orders/:id/collect` above:

- **rider** / **node** (origin) / **platform** — an Admin-configured percentage split
  (currently 60/20/20) of the order's delivery revenue (`amountKobo` minus the
  destination fee below).
- **destination_node** — a flat, dedicated fee (`PricingRule.destinationFeeKobo`, set via
  `POST /admin/pricing`) paid entirely to the destination Node. It's a separate line item,
  not part of the percentage split, so tuning the split ratio never changes what a
  destination Node earns and vice versa.

Each party's share is one immutable row; nothing here ever moves money, it only records
who's owed what and whether an Admin has settled it off-system yet.

**Orders carried by an external courier (Sendii) — pilot rule.** There's no Locoomo rider,
so instead of a `rider` row the rider's share is recorded as a **`courier_allocation`**
row: `partyId: null`, `payoutStatus: "not_payable"`. It is never paid to anyone — the
courier was already paid from Locoomo's prepaid courier wallet — and exists so the
allocation can be compared with the courier's actual cost per order while the final
settlement rule is agreed. The `node`, `destination_node` and `platform` rows are
unchanged. `mark-paid` refuses these rows (`409 REVENUE_SPLIT_NOT_PAYABLE`).

### `POST /api/v1/admin/revenue-split`

**Requires an authenticated Admin session.** Sets the split ratio used for every order
completed from now on — append-only 
Request:

```json
{ "riderPercent": 60, "nodePercent": 20, "platformPercent": 20 }
```

The three must sum to exactly 100 or the request is rejected. The 20% Node share goes
entirely to the **origin** Node (the one where the parcel was dropped off) — not split
with, and not paid to, the destination Node.

Response `201`, `data`:

```json
{
  "id": "uuid",
  "riderPercent": 60,
  "nodePercent": 20,
  "platformPercent": 20,
  "effectiveFrom": "2026-07-22T09:14:00.000Z",
  "createdByAdminId": "uuid",
  "createdByAdminEmail": "admin@example.com"
}
```

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin), `400 VALIDATION_FAILED`,
`400 INVALID_REVENUE_SPLIT` (doesn't sum to 100).

### `GET /api/v1/admin/revenue-split`

**Requires an authenticated Admin session.** Paginated rule history, newest first — same
shape as `GET /admin/pricing`.

### `GET /api/v1/admin/revenue-split/entries`

**Requires an authenticated Admin session.** Every revenue-split entry across every
completed order — four rows per order (rider, origin Node, destination Node, platform).
Paginated (see [Pagination](#pagination-list-endpoints)), newest first. Optional query
filters: `partyType` (`rider`/`node`/`destination_node`/`platform`/`courier_allocation`)
and `payoutStatus` (`pending`/`paid`/`not_payable`) — e.g.
`?partyType=rider&payoutStatus=pending` to see exactly what's still owed to riders.
`courier_allocation` rows show `partyLabel: "Courier allocation (not payable)"`.

Response `200`, `data`:

```json
{
  "items": [
    {
      "id": "uuid",
      "orderId": "uuid",
      "orderTrackingCode": "LCM-7K2X-9QRT",
      "partyType": "rider",
      "partyId": "uuid",
      "partyLabel": "rider@example.com",
      "amountKobo": 72000,
      "payoutStatus": "pending",
      "paidAt": null,
      "paidByAdminId": null,
      "paidByAdminEmail": null,
      "payoutAccountConfigured": true,
      "payoutBankCode": "058",
      "payoutBankName": "Guaranty Trust Bank",
      "payoutAccountNumber": "0123456789",
      "payoutAccountName": "Ada Lovelace",
      "createdAt": "2026-07-22T10:34:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

`partyLabel` is the rider's email, the Node's name (for both `node` and
`destination_node` rows), or `"Platform"` — so you know who to actually pay without a
second lookup. `paidByAdminEmail` is the same treatment for
`paidByAdminId`, `null` until the entry is marked paid. `amountKobo`, never naira (this
codebase stores money in kobo everywhere except the one typed-input exception on
`POST /admin/pricing`, which doesn't apply here — this is a read-only report).
`payoutAccountConfigured`/`payoutBank*`/`payoutAccount*` are the whole point of this
field set: the bank account to actually send money to sits right here, next to what's
owed — no more calling the rider or operator to ask. Always `false`/`null` on `platform`
rows (the platform has no payout account); `false`/`null` on any `rider`/`node`/
`destination_node` row where that party hasn't called `PATCH .../me/payout-account` yet.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin).

### `PATCH /api/v1/admin/revenue-split/entries/:id/mark-paid`

**Requires an authenticated Admin session.** Records that you settled this entry
off-system (bank transfer, cash, whatever) — this endpoint doesn't move any money itself,
it only tracks the fact so you don't lose track of what's already been paid. Idempotent:
marking an already-`paid` entry again just returns its current state, not an error.

No request body. Response `200`, `data`:

```json
{
  "id": "uuid",
  "payoutStatus": "paid",
  "paidAt": "2026-07-22T11:00:00.000Z",
  "paidByAdminId": "uuid",
  "paidByAdminEmail": "admin@example.com"
}
```

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin), `404 NOT_FOUND`,
`409 REVENUE_SPLIT_NOT_PAYABLE` (a `courier_allocation` row).

### `GET /api/v1/earnings/mine`

**Requires an authenticated Rider session.** Your own revenue-split entries — every order
you've delivered, what your 60% share came to, and whether it's been paid yet. Paginated.

Response `200`, `data.items[]` each:

```json
{
  "id": "uuid",
  "orderId": "uuid",
  "orderTrackingCode": "LCM-7K2X-9QRT",
  "partyType": "rider",
  "amountKobo": 72000,
  "payoutStatus": "pending",
  "paidAt": null,
  "createdAt": "2026-07-22T10:34:00.000Z"
}
```

No `partyId`/`partyLabel` here (unlike the Admin view) — you already know who you are.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Rider).

### `GET /api/v1/earnings/my-node`

**Requires an authenticated NodeOperator session.** Your own Node's revenue-split
entries, across both roles it plays: a `node` row for orders where your Node was the
**origin** (the 20% split share), and a `destination_node` row for orders where your Node
was the **destination** (the flat destination fee). A Node that's neither origin nor
destination for a given order — or that only ever plays one role — simply sees rows of
the corresponding `partyType` and none of the other. Same response shape as
`GET /earnings/mine` (each item's `partyType` tells you which role it was). Paginated.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator).

## Admin: couriers and deliveries

All **Admin only**, under `/api/v1/admin/logistics`. These control live routing — every
change takes effect for the next order.

### `GET /api/v1/admin/logistics/providers`

Every courier, in routing order (lowest `priority` first):

```json
[
  {
    "key": "sendii",
    "label": "Sendii",
    "enabled": false,
    "registered": true,
    "priority": 10,
    "maxAttempts": 2,
    "assignTimeoutMinutes": 20,
    "minDistanceKm": 0.1,
    "maxDistanceKm": 80,
    "pilotNodeIds": null,
    "maxCostShare": 0.75,
    "lowBalanceAlertKobo": 5000000,
    "capabilities": {
      "vehicleClasses": ["bicycle", "motorbike", "car"],
      "handover": "provider_code",
      "updates": "webhook",
      "prepaidWallet": true
    },
    "activeDeliveries": 0
  }
]
```

`registered: false` means this deployment isn't running that courier's adapter (e.g. no
`SENDII_API_KEY`) — it's never routed to, whatever `enabled` says.

### `PATCH /api/v1/admin/logistics/providers/:key`

Any of: `enabled`, `priority` (1–10000), `maxAttempts` (1–10 per order),
`assignTimeoutMinutes` (1–1440, give up when no rider takes it), `minDistanceKm` /
`maxDistanceKm`, `pilotNodeIds` (only orders from these origin Nodes; `null` or `[]` = all),
`maxCostShare` (0.1–2: the most of an order's delivery fee this courier may cost before the
order goes elsewhere), `lowBalanceAlertNaira`. Omitted fields are unchanged; `null` clears
the nullable ones (no limit / no timeout / no cap / no alert). Returns the provider as above.

Typical rollout: pilot (`{ "enabled": true, "pilotNodeIds": ["<origin-node-id>"] }`), then
everywhere (`{ "pilotNodeIds": null }`), and off again (`{ "enabled": false }` — deliveries
already with the courier finish normally).

Errors: `400 VALIDATION_FAILED` (incl. min > max distance, unknown pilot Nodes), `404
NOT_FOUND`, `409 ILLEGAL_DELIVERY_ACTION` (switching off `in_house` — Locoomo riders are every
order's fallback).

### `GET /api/v1/admin/logistics/providers/:key/wallet`

Prepaid couriers only (`404` otherwise):

```json
{
  "providerKey": "sendii",
  "balanceKobo": 5000000,
  "heldKobo": 380000,
  "availableKobo": 4620000,
  "reservedForSurchargesKobo": 228000,
  "freeKobo": 4392000,
  "lowBalanceAlertKobo": 5000000,
  "lowBalance": true
}
```

`reservedForSurchargesKobo` is kept back for surcharges the courier's deliveries in
progress may still add (failed attempts, returns); `freeKobo` is what new bookings can
really use. When it drops below `lowBalanceAlertKobo` the API logs an error hourly, and
bookings start falling back to Locoomo riders once the wallet can't cover a delivery.
`502 LOGISTICS_PROVIDER_ERROR` if the courier can't be reached.

### `GET /api/v1/admin/logistics/vehicle-rules` · `PATCH …/vehicle-rules/:vehicleClass`

The rules that decide which vehicle a parcel needs (see [Pricing](#pricing)): per class
`rank` (smallest first), `enabled`, `parcelSizes`, `maxWeightKg`, `maxLongestSideCm`. PATCH
any of those. `404` for an unknown class.

### `GET /api/v1/admin/logistics/deliveries`

Every courier attempt, newest first, paginated. Filters: `status` (`requested`, `assigned`,
`picked_up`, `delivered`, `returning`, `returned`, `cancelled`), `provider`, `stuck=true` (in
progress but nothing heard for 30+ minutes), `from` / `to` (ISO dates). Each row: `id`,
`orderId`, `orderTrackingCode`, `orderStatus`, `provider`, `providerLabel`, `legType`,
`status`, `providerStatus`, `externalId`, `attemptNumber`, `vehicleClass`, `courierName`,
`courierPhone`, `quotedKobo`, `actualKobo`, `surchargeKobo`, `failureReason` (e.g.
`no_rider_found`, `assign_timeout`, `admin_fallback`, `QUOTE_ABOVE_LIMIT: …`), timestamps.

### `POST /api/v1/admin/logistics/deliveries/:id/retry` · `/fallback` · `/reconcile`

- **retry** — send a delivery to its courier again when it never got there (`status:
  requested`, no `externalId` — submission kept failing).
- **fallback** — take it from an external courier and give it to Locoomo riders: cancels with
  the courier (if they still allow it) and puts the order in the rider pool. Only before
  pickup (`requested` / `assigned`).
- **reconcile** — fetch the courier's current state now and apply it (normally done every
  few minutes automatically).

Each returns the delivery row. Errors: `404`, `409 ILLEGAL_DELIVERY_ACTION` (not applicable
in the delivery's state — the message says why), `502 LOGISTICS_PROVIDER_ERROR`.

### `GET /api/v1/admin/logistics/economics`

Per order that used an external courier: what the customer paid, the delivery fee, the
courier's cost (charged amount when settled, quote while in progress, surcharges included,
cancelled attempts free), the courier allocation it's measured against (the
`courier_allocation` earnings row once collected, else estimated from the current split
rule — `allocationEstimated`), and `marginKobo` = allocation − cost. Filters `provider`,
`from`, `to`; paginated, with `totals` across all matching orders:

```json
{
  "items": [
    {
      "orderId": "uuid", "orderTrackingCode": "LCM-4F2K-9XPT", "orderStatus": "completed",
      "providers": ["sendii"], "customerPaidKobo": 434400, "deliveryFeeKobo": 404400,
      "courierCostKobo": 240000, "courierAllocationKobo": 242640,
      "allocationEstimated": false, "marginKobo": 2640, "settled": true,
      "createdAt": "2026-10-22T09:00:00.000Z"
    }
  ],
  "page": 1, "limit": 20, "total": 1,
  "totals": { "orders": 1, "customerPaidKobo": 434400, "courierCostKobo": 240000,
              "courierAllocationKobo": 242640, "marginKobo": 2640 }
}
```

## Admin diagnostics

### `GET /api/v1/admin/capacity-audit`

**Requires an authenticated Admin session.** Read-only reconciliation report — both
`RiderProfile.currentActiveOrderCount` and `Node.currentCount` are mutable counters
(incremented on reservation, decremented on release)


Response `200`, `data`:

```json
{
  "riders": [
    { "riderId": "uuid", "riderEmail": "rider@example.com", "storedCount": 2, "expectedCount": 1 }
  ],
  "nodes": [
    { "nodeId": "uuid", "nodeName": "Yaba Node", "storedCount": 7, "expectedCount": 3 }
  ]
}
```

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin).

