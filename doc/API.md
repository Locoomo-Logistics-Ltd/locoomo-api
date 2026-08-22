# API Guide for Frontend Integration

What the frontend needs to consume this API: base URL, auth flow, response shape, error
codes, and endpoint-by-endpoint request/response contracts. Kept current as endpoints
ship — if something you need isn't here, it isn't built yet

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
| 401 | `UNAUTHENTICATED` | No valid `access_token` cookie on a protected route — missing, invalid, or expired. Refresh and retry |
| 403 | `ACCOUNT_SUSPENDED` | Password was correct but the account is suspended |
| 403 | `FORBIDDEN` | Valid session, but your role can't access this route |
| 404 | `NOT_FOUND` | Route or resource doesn't exist. Also returned for a Node that exists but isn't `active` when you're not an Admin — visibility is hidden as "not found," not `403`, so a non-Admin can't distinguish "doesn't exist" from "pending approval" |
| 401 | `INVALID_WEBHOOK_SIGNATURE` | `POST /payments/webhooks/paystack` signature didn't verify — not a frontend-facing error, listed for completeness |
| 409 | `EMAIL_ALREADY_REGISTERED` | Registration, or an admin invite, attempted with an email already on file |
| 409 | `NODE_OPERATOR_ALREADY_ONBOARDED` | `POST /node-operators/onboarding` called by an account that already has a Node |
| 409 | `RIDER_ALREADY_ONBOARDED` | `POST /riders/onboarding` called by an account that already has a rider profile |
| 409 | `NODE_CAPACITY_UNAVAILABLE` | `POST /payments/intents` — the origin Node filled up between you seeing it in `/nodes/nearby` and this request landing. Show the consumer a "that drop-off point just filled up, try another" message, not a generic error |
| 403 | `RIDER_NOT_ACTIVE` | `POST /handoffs/orders/:id/accept` — your rider role is valid but your `RiderProfile` isn't `active` yet (still `pending` Admin review, or `suspended`) |
| 409 | `RIDER_CAPACITY_UNAVAILABLE` | `POST /handoffs/orders/:id/accept` — you already have the maximum number of concurrent active deliveries (3). Finish or hand off one before accepting another |
| 409 | `ILLEGAL_ORDER_TRANSITION` | A handoff scan/confirm endpoint was called while the order isn't in the state that step expects — either stale client state or someone else already advanced it. Re-fetch the order and refresh the UI rather than retrying blindly |
| 401 | `INVALID_HANDOFF_CODE` | `POST /handoffs/orders/:id/confirm-handoff` and `POST /handoffs/orders/:id/collect` — the code was missing, expired, already used, locked out after too many wrong guesses, or just wrong. Deliberately identical for all of these, same enumeration-avoidance reasoning as other invalid-token errors; request/resend a fresh code either way |
| 409 | `ORDER_NOT_READY_FOR_COLLECTION` | `POST /handoffs/orders/:id/collection-code/resend` — called before `POST /handoffs/orders/:id/intake` has run (or after the order's already `completed`). There's no collection code to resend yet |
| 400 | `INVALID_REVENUE_SPLIT` | `POST /admin/revenue-split` — `riderPercent`/`nodePercent`/`platformPercent` didn't sum to 100 |
| 429 | `RATE_LIMITED` | Too many requests to this route from your IP. `/auth/register` and `/auth/login` allow 5/min; `/payments/intents` allows 5/min; everything else defaults to 100/min |
| 500 | `INTERNAL_ERROR` | Unexpected server failure — message is always the generic "Something went wrong," never internal detail. Report the `correlationId` to backend |
| 502 | `PAYMENT_PROVIDER_ERROR` | Paystack's API failed or was unreachable when placing an order — safe to let the consumer retry |
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

Request:

```json
{
  "firstName": "Ada",
  "lastName": "Lovelace",
  "email": "ada@example.com",
  "phone": "+2348012345678",
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
| `phone` | `+` optional, 7–15 digits |
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
  "phone": "+2348012345678",
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
  "operatingHours": "Mon-Sat 8am-7pm",
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
| `operatingHours` | optional free text, max 255 chars |
| `onboardingType` | optional, defaults to `field_recruited`. One of `field_recruited`, `warm_lead`, `chain_partner`, `franchise` — `portal` is rejected here (`400 VALIDATION_FAILED`), it's set only by the future self-registration flow |

Response `201`, `data`: same shape as the Node objects in the list/get responses below,
with `"status": "active"`.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin), `400 VALIDATION_FAILED`.

### `GET /api/v1/nodes`

Any authenticated role. Lists Nodes, paginated (see above). Non-Admins always see only
`active` Nodes, regardless of the `status` filter — this is what keeps
pending/suspended/inactive Nodes out of pickup-station listings. Admins can filter by
`status`.

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
  "createdAt": "2026-07-22T09:14:00.000Z"
}
```

### `GET /api/v1/nodes/nearby`

Any authenticated role. Proximity search — always `active`-only regardless of caller,
since its entire purpose is "where can I actually drop off a parcel right now." Backed
by a PostGIS `ST_DWithin`/`ST_Distance` query against a GiST-indexed geography column.

Query params (all required except pagination): `latitude`, `longitude`, `radiusKm`
(0.1–100), plus `page`/`limit`.

Response `200`, `data.items[]`: same shape as the list response above, plus
`distanceMeters` (straight-line distance from the query point), sorted nearest-first.

Errors: `400 VALIDATION_FAILED` (missing/out-of-range lat/lng/radius).

### `GET /api/v1/nodes/:id`

Any authenticated role. Non-Admins get `404 NOT_FOUND` for a Node that exists but isn't
`active` — same shape as "doesn't exist," so pending/suspended Nodes can't be
fingerprinted by ID. Admins can fetch any Node regardless of status.

Response `200`, `data`: same shape as one list item.

Errors: `404 NOT_FOUND` (doesn't exist, or exists but hidden from your role),
`400 VALIDATION_FAILED` (malformed id).

### `PATCH /api/v1/nodes/:id`

**Requires an authenticated Admin session.** All fields optional — send only what's
changing. This is also how an Admin approves a pending Node (`{ "status": "active" }`)
or retires one (`{ "status": "inactive" }` / `"suspended"`) — there is no delete
endpoint, a Node is never removed, only status-transitioned.

Request (all optional): `name`, `address`, `city`, `state`, `country`, `latitude`,
`longitude`, `capacity`, `operatingHours`, `status`. `onboardingType` is immutable after
creation and isn't accepted here.

Response `200`, `data`: the updated Node, same shape as one list item.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin), `400 VALIDATION_FAILED`,
`404 NOT_FOUND`.

### `POST /api/v1/node-operators/onboarding`

**Requires an authenticated NodeOperator session** (role `node_operator` — set via
`POST /auth/register`'s `role` field). This is the second step of self-registration:
sets up the operator's Node (location, capacity). Creates the `Node` (`status: pending`,
`onboardingType: portal`) and links it to your account in one action — the Node stays
invisible in `/nodes`/`/nodes/nearby` for everyone except Admins until an Admin approves
it (`PATCH /node-operators/:id/approve` below). One Node per operator — calling this
twice on the same account returns `409`.

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
  "operatingHours": "Mon-Sat 8am-7pm"
}
```

Response `201`, `data`:

```json
{
  "profileId": "uuid",
  "node": { "...": "same Node shape as GET /nodes/:id, status will be \"pending\"" }
}
```

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a NodeOperator),
`400 VALIDATION_FAILED`, `409 NODE_OPERATOR_ALREADY_ONBOARDED`.

### `GET /api/v1/node-operators/me`

**Requires an authenticated NodeOperator session.** Returns your own profile + Node —
use this to check whether your Node has been approved yet (`data.node.status`).
`404 NOT_FOUND` if you haven't completed onboarding yet (call the endpoint above first).

Response `200`, `data`: same shape as the onboarding response.

### `GET /api/v1/node-operators/pending`

**Requires an authenticated Admin session.** The review queue — NodeOperators who have
registered and completed onboarding but aren't approved yet. Paginated (see the
pagination section above).

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
queue above (not the Node id or the user id). Approves the operator — flips the User's
status to `active` and the Node's status to `active` together, in one transaction. After
this, the Node shows up in `/nodes`/`/nodes/nearby` for everyone.

No request body.

Response `200`, `data`: same shape as the onboarding response, with `node.status:
"active"`.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin), `404 NOT_FOUND`
(no profile with that id).

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
  ]
}
```

`viewUrl` is a signed, time-limited Cloudinary delivery URL, freshly generated on every
response — never store it, it's not permanent.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (not a Rider), `400 VALIDATION_FAILED`,
`400 INVALID_VERIFICATION_DOCUMENT` (the `cloudinaryPublicId` doesn't correspond to a
real upload), `409 RIDER_ALREADY_ONBOARDED`.

### `GET /api/v1/riders/me`

**Requires an authenticated Rider session.** Returns your own profile + documents — use
this to check whether you've been approved yet (`data.status`). `404 NOT_FOUND` if you
haven't completed onboarding yet.

Response `200`, `data`: same shape as the onboarding response.

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
Historical orders keep referencing whichever rule was current when their fee was
calculated, so past orders stay explainable even after rates change.

Request:

```json
{ "baseFeeNaira": 500, "perKmRateNaira": 100, "destinationFeeNaira": 50 }
```

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
  "parcelSize": "small"
}
```

| Field | Rules |
|---|---|
| `receiverFullName` | 1–100 chars |
| `receiverEmail` | valid email |
| `receiverPhone` | `+` optional, 7–15 digits, same format as registration's `phone` |
| `parcelDescription` | 1–500 chars |
| `parcelSize` | one of `small`, `medium`, `large`, `extra_large` — informational for the Node operator, does **not** affect the fee (pricing is distance-only) |

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
  "feeBreakdown": {
    "pricingRuleId": "uuid",
    "baseFeeKobo": 50000,
    "perKmRateKobo": 10000,
    "destinationFeeKobo": 5000,
    "distanceKm": 4.2,
    "totalKobo": 97000
  },
  "amountKobo": 97000,
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
`404 NOT_FOUND` (either Node doesn't exist or isn't active), `409
NODE_CAPACITY_UNAVAILABLE`, `429 RATE_LIMITED`, `502 PAYMENT_PROVIDER_ERROR`, `503
PRICING_NOT_CONFIGURED`.

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
      "createdAt": "2026-07-22T09:29:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

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
origin Node (`status: parcel_received_at_origin`, no rider assigned yet), sorted
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
  "destinationNodeId": "uuid"
}
```

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Rider), `403 RIDER_NOT_ACTIVE`,
`409 ILLEGAL_ORDER_TRANSITION` (order already claimed, or not yet at
`parcel_received_at_origin`), `409 RIDER_CAPACITY_UNAVAILABLE`.

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

**Requires an authenticated NodeOperator session.** The counterpart to `my-orders`, for
the other side of the counter — every order that's ever touched your Node, either as
origin or destination, current and past, newest first. `myRole` on each item tells you
which side your Node played on that particular order (a Node is an origin for some orders
and a destination for others). Paginated (see [Pagination](#pagination-list-endpoints)).

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
      "myRole": "origin"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

No receiver details here either — same reasoning as `by-tracking-code` below, this is a
history/overview view, not the collection step itself.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator).

### `GET /api/v1/handoffs/orders/by-tracking-code/:code`

**Requires an authenticated NodeOperator session**, and only returns orders whose
`originNodeId` is *your* Node (`404 NOT_FOUND` otherwise — not-found-not-forbidden, same
pattern as everywhere else). This is what your app calls after scanning/typing a
consumer's QR/tracking code at drop-off, to preview the parcel before confirming receipt.

Response `200`, `data`:

```json
{
  "id": "uuid",
  "trackingCode": "LCM-4F2K-9XPT",
  "status": "awaiting_drop_off",
  "originNodeId": "uuid",
  "destinationNodeId": "uuid",
  "destinationNodeName": "Lekki Node",
  "parcelDescription": "A small box of documents",
  "parcelSize": "small",
  "createdAt": "2026-07-22T09:29:00.000Z"
}
```

No receiver PII here either — that's only relevant at the destination Node, at
collection.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator), `404 NOT_FOUND`.

### `POST /api/v1/handoffs/orders/:id/drop-off`

**Requires an authenticated NodeOperator session**, ownership-scoped the same way as the
lookup above. Confirms the consumer has physically handed over the parcel —
`awaiting_drop_off → parcel_received_at_origin`. Idempotent: calling this twice for the
same order is a safe no-op the second time, same response either way.

Response `200`, `data`: same shape as the accept response above, `status:
"parcel_received_at_origin"`.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator), `404 NOT_FOUND` (not
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

### `POST /api/v1/handoffs/orders/:id/confirm-handoff`

**Requires an authenticated NodeOperator session, ownership-scoped to the correct side**
— `type: "rider_pickup"` must come from the *origin* Node's operator, `type:
"rider_arrival"` from the *destination* Node's operator (`404 NOT_FOUND` from the wrong
one, same not-found-not-forbidden pattern as everything else). This is what you call
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

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator), `404 NOT_FOUND` (wrong
Node for this `type`), `401 INVALID_HANDOFF_CODE`, `429 RATE_LIMITED`,
`400 VALIDATION_FAILED`.

### `POST /api/v1/handoffs/orders/:id/intake`

**Requires an authenticated NodeOperator session**, ownership-scoped to the
*destination* Node (`404 NOT_FOUND` otherwise). Destination-side equivalent of drop-off —
confirms the parcel has physically arrived at your counter (the rider already moved it to
`arrived_at_destination` via `confirm-handoff`). `arrived_at_destination →
ready_for_collection`. In the same step, mints a 6-digit collection code and emails it to
the receiver — you never see the code yourself, only the receiver does. Idempotent:
calling this twice is a safe no-op the second time.

Response `200`, `data`: same shape as the accept response above, `status:
"ready_for_collection"`.

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator), `404 NOT_FOUND` (not
your Node), `409 ILLEGAL_ORDER_TRANSITION` (order isn't at `arrived_at_destination`).

### `POST /api/v1/handoffs/orders/:id/collection-code/resend`

**Requires an authenticated NodeOperator session**, ownership-scoped to the destination
Node. Use this when the receiver is standing at the counter but says they never got the
email, or their original code expired (1 hour TTL) — mints a fresh code, superseding the
prior one, and re-emails it. Rate-limited (5/min) since it sends a real email each time.

No request body. Response `200`, `data`:

```json
{ "expiresAt": "2026-07-22T10:34:00.000Z" }
```

The code itself is never in this response — it only ever goes to the receiver's email,
never to the operator's session or any API response, the mirror image of the rider
pickup/arrival codes (which are only ever shown to the rider, never emailed).

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator), `404 NOT_FOUND` (not
your Node), `409 ORDER_NOT_READY_FOR_COLLECTION` (intake hasn't run yet, or the order's
already `completed`), `429 RATE_LIMITED`.

### `POST /api/v1/handoffs/orders/:id/collect`

**Requires an authenticated NodeOperator session**, ownership-scoped to the destination
Node. Final step — the receiver reads you the code from their email, you ask for and
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

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-NodeOperator), `404 NOT_FOUND` (wrong
Node), `401 INVALID_HANDOFF_CODE`, `429 RATE_LIMITED`, `400 VALIDATION_FAILED`,
`503 REVENUE_SPLIT_NOT_CONFIGURED` (Admin hasn't set a revenue-split ratio yet — see the
`earnings` endpoints below).

This is also the end of the parcel's lifecycle in the system today. The moment an order
reaches `completed`, its revenue is split and recorded — see the `earnings` endpoints
below, which is where that money is actually tracked. Payout itself is still manual (an
Admin disburses off-system); these endpoints are the record of what's owed, not a payout
flow.

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
filters: `partyType` (`rider`/`node`/`destination_node`/`platform`) and `payoutStatus`
(`pending`/`paid`) — e.g. `?partyType=rider&payoutStatus=pending` to see exactly what's
still owed to riders.

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

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Admin), `404 NOT_FOUND`.

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

