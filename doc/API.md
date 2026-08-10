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
| 429 | `RATE_LIMITED` | Too many requests to this route from your IP. `/auth/register` and `/auth/login` allow 5/min; `/payments/intents` allows 5/min; everything else defaults to 100/min |
| 500 | `INTERNAL_ERROR` | Unexpected server failure — message is always the generic "Something went wrong," never internal detail. Report the `correlationId` to backend |
| 502 | `PAYMENT_PROVIDER_ERROR` | Paystack's API failed or was unreachable when placing an order — safe to let the consumer retry |
| 503 | `PRICING_NOT_CONFIGURED` | No Admin-configured pricing rule exists yet — an ops/config gap, not something the consumer caused; surface as "orders temporarily unavailable" |

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
  "documentType": "rating_screenshot",
  "cloudinaryPublicId": "riders/{your-user-id}/verification/rating_screenshot/abc123"
}
```

Response `201`, `data`:

```json
{
  "profileId": "uuid",
  "currentEmployer": "Existing Delivery Co",
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
{ "baseFeeNaira": 500, "perKmRateNaira": 100 }
```

Response `201`, `data`:

```json
{
  "id": "uuid",
  "baseFeeNaira": 500,
  "baseFeeKobo": 50000,
  "perKmRateNaira": 100,
  "perKmRateKobo": 10000,
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
    "distanceKm": 4.2,
    "totalKobo": 92000
  },
  "amountKobo": 92000,
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
exists, though there's no endpoint to view it yet), `failed`, or `expired` (the ~15
minute hold lapsed unpaid).

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non-Consumer), `404 NOT_FOUND`.

### `POST /api/v1/payments/webhooks/paystack`

Server-to-server only — Paystack calls this, your frontend never does. Listed here only
for completeness. Unauthenticated (no session cookie involved), verified instead via
Paystack's HMAC signature header.


